#!/usr/bin/env node
/**
 * Check a codebase-map report directory against the report contract.
 *
 *   node scripts/check-report.mjs <report-dir>
 *
 * This module owns the mechanical half of SKILL.md's completion check: the
 * invariants a file can decide. The other half — whether the focused view
 * answers the question, whether captions are concise, whether anything is
 * clipped — needs judgement and stays in SKILL.md as prose.
 *
 * The palette is compared against docs/report-template.html, which is its single
 * home, so a colour cannot silently diverge between the template and a report.
 *
 * Zero dependencies, so it runs anywhere Node runs.
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const REQUIRED_FILES = ['index.json', 'context.md', 'architecture.html', 'evidence.md']

const CONFIDENCE = new Set(['confirmed', 'inferred', 'unknown'])
const FILE_KIND = new Set(['source', 'test', 'config', 'docs', 'asset', 'generated'])
const RELATIONSHIP_KIND = new Set([
  'calls', 'imports', 'routes', 'reads', 'writes', 'stores',
  'references', 'publishes', 'consumes', 'renders', 'tests',
])
const CARDINALITY = new Set([
  'one-to-one', 'one-to-many', 'many-to-one', 'many-to-many', 'unknown',
])

// A report earns a search control once its overview stops fitting on one
// screen. SKILL.md targets 10–15 concepts for the overview; this takes the
// lower bound rather than inventing a second number.
const SEARCH_CONCEPT_THRESHOLD = 10

// context.md is the orientation layer, not the index. Keep it loadable whole.
const MAX_CONTEXT_BYTES = 12 * 1024

// High-signal shapes only. The bare word "secret" is not evidence of a leak.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API key'],
]

const DOWNLOAD_ATTRIBUTE = /\sdownload(?=[\s/>=])/i
const ARCHIVE_LINK = /href\s*=\s*"[^"]*\.(?:zip|tar|tgz|gz|rar|7z)"/i
const SEARCH_CONTROL = /(?:type\s*=\s*"search"|role\s*=\s*"search"|class\s*=\s*"[^"]*search|id\s*=\s*"[^"]*search"|<input[^>]*\bsearch\b)/i
const CONCEPT_MARKER = /\bdata-concept-id\s*=\s*"([^"]*)"/g

// The report template is the single home for the palette. Compare against it so
// a colour changed in one place cannot silently diverge from the others.
const TEMPLATE_PATH = new URL('../docs/report-template.html', import.meta.url)

const errors = []

function fail(message) {
  errors.push(message)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where} must be a non-empty string`)
    return false
  }
  return true
}

function requireArray(value, where) {
  if (!Array.isArray(value)) {
    fail(`${where} must be an array`)
    return false
  }
  return true
}

function requireEvidenceAndConfidence(entry, where) {
  if (requireArray(entry.evidence, `${where}.evidence`)) {
    if (entry.evidence.length === 0) fail(`${where}.evidence is empty; every material entry needs a source`)
    entry.evidence.forEach((item, i) => requireString(item, `${where}.evidence[${i}]`))
  }
  if (!CONFIDENCE.has(entry.confidence)) {
    fail(`${where}.confidence must be one of ${[...CONFIDENCE].join(', ')} (got ${JSON.stringify(entry.confidence)})`)
  }
}

function checkIndex(index) {
  const fileIds = new Set()
  const conceptIds = new Set()

  if (typeof index.schemaVersion !== 'number') fail('index.json is missing a numeric schemaVersion')

  if (!isPlainObject(index.repository)) {
    fail('index.json.repository must be an object')
  } else {
    requireString(index.repository.name, 'index.json.repository.name')
  }

  if (requireArray(index.files, 'index.json.files')) {
    index.files.forEach((file, i) => {
      const where = `index.json.files[${i}]`
      if (requireString(file.id, `${where}.id`)) fileIds.add(file.id)
      requireString(file.path, `${where}.path`)
      requireString(file.summary, `${where}.summary`)
      if (!FILE_KIND.has(file.kind)) {
        fail(`${where}.kind must be one of ${[...FILE_KIND].join(', ')} (got ${JSON.stringify(file.kind)})`)
      }
      requireEvidenceAndConfidence(file, where)
      if (requireArray(file.symbols, `${where}.symbols`) === false) return
    })
  }

  if (requireArray(index.concepts, 'index.json.concepts')) {
    index.concepts.forEach((concept, i) => {
      const where = `index.json.concepts[${i}]`
      if (requireString(concept.id, `${where}.id`)) conceptIds.add(concept.id)
      requireString(concept.name, `${where}.name`)
      requireString(concept.summary, `${where}.summary`)
      requireEvidenceAndConfidence(concept, where)
    })
  }

  if (requireArray(index.relationships, 'index.json.relationships')) {
    index.relationships.forEach((relationship, i) => {
      const where = `index.json.relationships[${i}]`
      requireString(relationship.summary, `${where}.summary`)
      if (!RELATIONSHIP_KIND.has(relationship.kind)) {
        fail(`${where}.kind must be one of ${[...RELATIONSHIP_KIND].join(', ')} (got ${JSON.stringify(relationship.kind)})`)
      }
      if ('cardinality' in relationship && !CARDINALITY.has(relationship.cardinality)) {
        fail(`${where}.cardinality must be one of ${[...CARDINALITY].join(', ')} (got ${JSON.stringify(relationship.cardinality)})`)
      }
      requireEvidenceAndConfidence(relationship, where)
    })
  }

  if (requireArray(index.flows, 'index.json.flows')) {
    index.flows.forEach((flow, i) => {
      const where = `index.json.flows[${i}]`
      requireString(flow.id, `${where}.id`)
      requireString(flow.name, `${where}.name`)
      requireArray(flow.steps, `${where}.steps`)
      requireEvidenceAndConfidence(flow, where)
    })
  }

  if (!requireArray(index.gaps, 'index.json.gaps')) return { fileIds, conceptIds }

  // Second pass: now that every id is known, check that each reference resolves.
  if (Array.isArray(index.relationships)) {
    index.relationships.forEach((relationship, i) => {
      const where = `index.json.relationships[${i}]`
      for (const end of ['source', 'target']) {
        const id = relationship[end]
        if (typeof id !== 'string' || !conceptIds.has(id)) {
          fail(`${where}.${end} "${id}" is not a concept id`)
        }
      }
    })
  }

  if (Array.isArray(index.flows)) {
    index.flows.forEach((flow, i) => {
      if (!Array.isArray(flow.steps)) return
      flow.steps.forEach((step, j) => {
        if (typeof step !== 'string' || !conceptIds.has(step)) {
          fail(`index.json.flows[${i}].steps[${j}] "${step}" is not a concept id`)
        }
      })
    })
  }

  if (Array.isArray(index.concepts)) {
    index.concepts.forEach((concept, i) => {
      if (!Array.isArray(concept.ownerFileIds)) return
      concept.ownerFileIds.forEach((fileId, j) => {
        if (typeof fileId !== 'string' || !fileIds.has(fileId)) {
          fail(`index.json.concepts[${i}].ownerFileIds[${j}] "${fileId}" is not a file id`)
        }
      })
    })
  }

  return { fileIds, conceptIds }
}

function checkHtml(html, conceptIds) {
  CONCEPT_MARKER.lastIndex = 0
  const markers = new Set()
  let match
  while ((match = CONCEPT_MARKER.exec(html)) !== null) markers.add(match[1])

  if (markers.size === 0) {
    fail('architecture.html carries no data-concept-id; diagram nodes and detail entries must name their concept')
  }

  if (conceptIds) {
    for (const id of markers) {
      if (id === '') {
        fail('architecture.html has an empty data-concept-id')
      } else if (!conceptIds.has(id)) {
        fail(`architecture.html references concept "${id}", which is not in the index`)
      }
    }
    if (conceptIds.size > SEARCH_CONCEPT_THRESHOLD && !SEARCH_CONTROL.test(html)) {
      fail(`architecture.html has ${conceptIds.size} concepts but no search control (required above ${SEARCH_CONCEPT_THRESHOLD})`)
    }
  }

  if (DOWNLOAD_ATTRIBUTE.test(html) || ARCHIVE_LINK.test(html)) {
    fail('architecture.html offers a source-code download control; the report must stay read-only')
  }
}

function paletteOf(html) {
  const root = html.match(/:root\s*\{([\s\S]*?)\}/)
  if (!root) return null
  const vars = {}
  for (const match of root[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[match[1].toLowerCase()] = match[2].trim().toLowerCase()
  }
  return Object.keys(vars).length ? vars : null
}

async function checkPalette(reportHtml) {
  let templateHtml
  try {
    templateHtml = await readFile(TEMPLATE_PATH, 'utf8')
  } catch {
    return
  }

  const expected = paletteOf(templateHtml)
  if (!expected) return

  const actual = paletteOf(reportHtml)
  if (!actual) {
    fail('architecture.html has no :root palette to compare against the report template')
    return
  }

  for (const [name, value] of Object.entries(expected)) {
    if (!(name in actual)) {
      fail(`architecture.html is missing palette variable ${name}; the template defines it as ${value}`)
    } else if (actual[name] !== value) {
      fail(`architecture.html sets ${name} to ${actual[name]}; the template defines ${value}`)
    }
  }
}

async function checkSecrets(dir) {
  for (const name of REQUIRED_FILES) {
    let contents
    try {
      contents = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(contents)) fail(`${name} looks like it contains a ${label}`)
    }
  }
}

async function checkContextBudget(dir, present) {
  if (!present['context.md']) return
  const info = await stat(join(dir, 'context.md'))
  if (info.size > MAX_CONTEXT_BYTES) {
    fail(`context.md is ${info.size} bytes; the budget is ${MAX_CONTEXT_BYTES} so it stays loadable whole`)
  }
}

async function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/check-report.mjs <report-dir>')
    process.exit(2)
  }

  const dir = resolve(target)
  let info
  try {
    info = await stat(dir)
  } catch {
    console.error(`report directory not found: ${dir}`)
    process.exit(2)
  }
  if (!info.isDirectory()) {
    console.error(`not a directory: ${dir}`)
    process.exit(2)
  }

  const present = {}
  for (const name of REQUIRED_FILES) {
    try {
      await stat(join(dir, name))
      present[name] = true
    } catch {
      present[name] = false
      fail(`missing report file: ${name}`)
    }
  }

  let index = null
  if (present['index.json']) {
    const raw = await readFile(join(dir, 'index.json'), 'utf8')
    try {
      index = JSON.parse(raw)
    } catch (error) {
      fail(`index.json is not valid JSON: ${error.message}`)
    }
  }

  let conceptIds = null
  if (index) {
    if (!isPlainObject(index)) {
      fail('index.json must be an object')
    } else {
      conceptIds = checkIndex(index).conceptIds
    }
  }

  if (present['architecture.html']) {
    const html = await readFile(join(dir, 'architecture.html'), 'utf8')
    checkHtml(html, conceptIds)
    await checkPalette(html)
  }

  await checkSecrets(dir)
  await checkContextBudget(dir, present)

  if (errors.length === 0) {
    console.log(`report check passed: ${dir}`)
    return
  }

  console.error(`report check failed: ${dir}\n`)
  for (const error of errors) console.error(`  x ${error}`)
  console.error(`\n${errors.length} problem${errors.length === 1 ? '' : 's'}`)
  process.exit(1)
}

await main()
