import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkReport,
  checkIndex,
  checkHtml,
  checkPalette,
  checkSecrets,
  checkContextBudget,
  paletteOf,
  REQUIRED_FILES,
  SEARCH_CONCEPT_THRESHOLD,
  MAX_CONTEXT_BYTES,
} from '../scripts/check-report.mjs'

test('REQUIRED_FILES defines the exact contract set', () => {
  assert.deepEqual(REQUIRED_FILES, ['index.json', 'context.md', 'architecture.html', 'evidence.md'])
})

test('checkReport: passes on the valid tiny-app example fixture', async () => {
  const result = await checkReport('examples/tiny-app/reports/codebase-map/tiny-app')
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.match(result.dir, /tiny-app/)
})

test('checkReport: returns fatal error when directory does not exist', async () => {
  const result = await checkReport('non-existent-directory-xyz')
  assert.equal(result.ok, false)
  assert.equal(result.fatal, true)
  assert.match(result.errors[0], /report directory not found/)
})

test('checkIndex: catches missing schemaVersion and repository', () => {
  const errors = []
  checkIndex({}, errors)
  assert.ok(errors.some(e => e.includes('missing a numeric schemaVersion')))
  assert.ok(errors.some(e => e.includes('index.json.repository must be an object')))
})

test('checkIndex: validates files, evidence, and confidence', () => {
  const errors = []
  const invalidIndex = {
    schemaVersion: 1,
    repository: { name: 'test' },
    files: [
      {
        id: 'f1',
        path: 'src/main.ts',
        summary: 'Entrypoint',
        kind: 'unsupported-kind',
        evidence: [],
        confidence: 'guessed',
        symbols: ['s1'],
      },
    ],
    concepts: [],
    relationships: [],
    flows: [],
    gaps: [],
  }
  checkIndex(invalidIndex, errors)
  assert.ok(errors.some(e => e.includes('must be one of source, test, config, docs, asset, generated')))
  assert.ok(errors.some(e => e.includes('evidence is empty; every material entry needs a source')))
  assert.ok(errors.some(e => e.includes('confidence must be one of confirmed, inferred, unknown')))
})

test('checkIndex: catches unresolved concept references in relationships and flows', () => {
  const errors = []
  const index = {
    schemaVersion: 1,
    repository: { name: 'test' },
    files: [
      {
        id: 'f1',
        path: 'a.ts',
        summary: 'File A',
        kind: 'source',
        evidence: ['a.ts:1'],
        confidence: 'confirmed',
        symbols: [],
      },
    ],
    concepts: [
      {
        id: 'c1',
        name: 'Concept 1',
        summary: 'First concept',
        ownerFileIds: ['unknown-file-id'],
        evidence: ['a.ts:1'],
        confidence: 'confirmed',
      },
    ],
    relationships: [
      {
        source: 'c1',
        target: 'ghost-concept',
        kind: 'calls',
        summary: 'Calls ghost',
        evidence: ['a.ts:2'],
        confidence: 'confirmed',
      },
    ],
    flows: [
      {
        id: 'flow-1',
        name: 'Test flow',
        steps: ['c1', 'missing-step-concept'],
        evidence: ['a.ts:3'],
        confidence: 'confirmed',
      },
    ],
    gaps: [],
  }
  checkIndex(index, errors)
  assert.ok(errors.some(e => e.includes('ownerFileIds[0] "unknown-file-id" is not a file id')))
  assert.ok(errors.some(e => e.includes('target "ghost-concept" is not a concept id')))
  assert.ok(errors.some(e => e.includes('steps[1] "missing-step-concept" is not a concept id')))
})

test('checkHtml: flags missing or empty data-concept-id', () => {
  const noMarkersErrors = []
  checkHtml('<div><span>no concepts here</span></div>', new Set(['c1']), noMarkersErrors)
  assert.ok(noMarkersErrors.some(e => e.includes('carries no data-concept-id')))

  const emptyMarkerErrors = []
  checkHtml('<div data-concept-id=""></div>', new Set(['c1']), emptyMarkerErrors)
  assert.ok(emptyMarkerErrors.some(e => e.includes('empty data-concept-id')))

  const unknownMarkerErrors = []
  checkHtml('<div data-concept-id="unregistered"></div>', new Set(['c1']), unknownMarkerErrors)
  assert.ok(unknownMarkerErrors.some(e => e.includes('references concept "unregistered", which is not in the index')))
})

test('checkHtml: enforces search control threshold (> 10 concepts)', () => {
  const manyConcepts = new Set(Array.from({ length: 11 }, (_, i) => `c${i}`))
  const htmlWithoutSearch = Array.from(manyConcepts).map(id => `<div data-concept-id="${id}"></div>`).join('')

  const errorsWithoutSearch = []
  checkHtml(htmlWithoutSearch, manyConcepts, errorsWithoutSearch)
  assert.ok(errorsWithoutSearch.some(e => e.includes(`has 11 concepts but no search control (required above ${SEARCH_CONCEPT_THRESHOLD})`)))

  const errorsWithSearch = []
  const htmlWithSearch = `<input type="search" />` + htmlWithoutSearch
  checkHtml(htmlWithSearch, manyConcepts, errorsWithSearch)
  assert.equal(errorsWithSearch.length, 0)
})

test('checkHtml: rejects download attributes and archive links', () => {
  const downloadErrors = []
  checkHtml('<a href="data.json" download>Download</a><div data-concept-id="c1"></div>', new Set(['c1']), downloadErrors)
  assert.ok(downloadErrors.some(e => e.includes('offers a source-code download control')))

  const archiveErrors = []
  checkHtml('<a href="archive.zip">Code</a><div data-concept-id="c1"></div>', new Set(['c1']), archiveErrors)
  assert.ok(archiveErrors.some(e => e.includes('offers a source-code download control')))
})

test('checkPalette: detects missing or mismatched palette variables', () => {
  const template = `:root { --bg: #17191d; --accent: #c9f36b; }`

  const validHtml = `<style>:root { --bg: #17191d; --accent: #c9f36b; }</style>`
  const validErrors = []
  checkPalette(validHtml, template, validErrors)
  assert.equal(validErrors.length, 0)

  const missingVarHtml = `<style>:root { --bg: #17191d; }</style>`
  const missingVarErrors = []
  checkPalette(missingVarHtml, template, missingVarErrors)
  assert.ok(missingVarErrors.some(e => e.includes('missing palette variable --accent')))

  const mismatchedHtml = `<style>:root { --bg: #ffffff; --accent: #c9f36b; }</style>`
  const mismatchedErrors = []
  checkPalette(mismatchedHtml, template, mismatchedErrors)
  assert.ok(mismatchedErrors.some(e => e.includes('sets --bg to #ffffff; the template defines #17191d')))

  const noPaletteHtml = `<div>No style</div>`
  const noPaletteErrors = []
  checkPalette(noPaletteHtml, template, noPaletteErrors)
  assert.ok(noPaletteErrors.some(e => e.includes('has no :root palette')))
})

test('paletteOf: extracts lowercase CSS variables accurately', () => {
  const html = `<style>:root { --Canvas: #121212; --TEXT-PRIMARY: #FAFAFA; }</style>`
  const vars = paletteOf(html)
  assert.deepEqual(vars, {
    '--canvas': '#121212',
    '--text-primary': '#fafafa',
  })
})

test('checkSecrets: flags credentials and secret patterns', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'report-secrets-test-'))
  try {
    await writeFile(join(tempDir, 'context.md'), 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')
    const errors = []
    await checkSecrets(tempDir, errors)
    assert.ok(errors.some(e => e.includes('context.md looks like it contains a GitHub token')))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('checkContextBudget: flags context.md exceeding byte limit', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'report-budget-test-'))
  try {
    const oversizedContent = 'x'.repeat(MAX_CONTEXT_BYTES + 10)
    await writeFile(join(tempDir, 'context.md'), oversizedContent)
    const errors = []
    await checkContextBudget(tempDir, { 'context.md': true }, errors)
    assert.ok(errors.some(e => e.includes(`the budget is ${MAX_CONTEXT_BYTES}`)))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
