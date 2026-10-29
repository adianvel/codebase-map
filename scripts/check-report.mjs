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
import { fileURLToPath } from 'node:url'

export const REQUIRED_FILES = ['index.json', 'context.md', 'architecture.html', 'evidence.md']

export const CONFIDENCE = new Set(['confirmed', 'inferred', 'unknown'])
export const FILE_KIND = new Set(['source', 'test', 'config', 'docs', 'asset', 'generated'])
export const RELATIONSHIP_KIND = new Set([
  'calls', 'imports', 'routes', 'reads', 'writes', 'stores',
  'references', 'publishes', 'consumes', 'renders', 'tests',
])
export const CARDINALITY = new Set([
  'one-to-one', 'one-to-many', 'many-to-one', 'many-to-many', 'unknown',
])

// A report earns a search control once its overview stops fitting on one
// screen. SKILL.md targets 10–15 concepts for the overview; this takes the
// lower bound rather than inventing a second number.
export const SEARCH_CONCEPT_THRESHOLD = 10

// context.md is the orientation layer, not the index. Keep it loadable whole.
export const MAX_CONTEXT_BYTES = 12 * 1024

// High-signal shapes only. The bare word "secret" is not evidence of a leak.
export const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API key'],
]

export const DOWNLOAD_ATTRIBUTE = /\sdownload(?=[\s/>=])/i
export const ARCHIVE_LINK = /href\s*=\s*"[^"]*\.(?:zip|tar|tgz|gz|rar|7z)"/i
export const SEARCH_CONTROL = /(?:type\s*=\s*"search"|role\s*=\s*"search"|class\s*=\s*"[^"]*search|id\s*=\s*"[^"]*search"|<input[^>]*\bsearch\b)/i
export const CONCEPT_MARKER = /\bdata-concept-id\s*=\s*"([^"]*)"/g

// The report template is the single home for the palette. Compare against it so
// a colour changed in one place cannot silently diverge from the others.
export const TEMPLATE_PATH = new URL('../docs/report-template.html', import.meta.url)

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value, where, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${where} must be a non-empty string`)
    return false
  }
  return true
}

function requireArray(value, where, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${where} must be an array`)
    return false
  }
  return true
}

function requireEvidenceAndConfidence(entry, where, errors) {
  if (requireArray(entry.evidence, `${where}.evidence`, errors)) {
    if (entry.evidence.length === 0) {
      errors.push(`${where}.evidence is empty; every material entry needs a source`)
    }
    entry.evidence.forEach((item, i) => requireString(item, `${where}.evidence[${i}]`, errors))
  }
  if (!CONFIDENCE.has(entry.confidence)) {
    errors.push(`${where}.confidence must be one of ${[...CONFIDENCE].join(', ')} (got ${JSON.stringify(entry.confidence)})`)
  }
}

export function checkIndex(index, errors = []) {
  const fileIds = new Set()
  const conceptIds = new Set()

  if (typeof index.schemaVersion !== 'number') {
    errors.push('index.json is missing a numeric schemaVersion')
  }

  if (!isPlainObject(index.repository)) {
    errors.push('index.json.repository must be an object')
  } else {
    requireString(index.repository.name, 'index.json.repository.name', errors)
  }

  if (requireArray(index.files, 'index.json.files', errors)) {
    index.files.forEach((file, i) => {
      const where = `index.json.files[${i}]`
      if (requireString(file.id, `${where}.id`, errors)) fileIds.add(file.id)
      requireString(file.path, `${where}.path`, errors)
      requireString(file.summary, `${where}.summary`, errors)
      if (!FILE_KIND.has(file.kind)) {
        errors.push(`${where}.kind must be one of ${[...FILE_KIND].join(', ')} (got ${JSON.stringify(file.kind)})`)
      }
      requireEvidenceAndConfidence(file, where, errors)
      if (requireArray(file.symbols, `${where}.symbols`, errors) === false) return
    })
  }

  if (requireArray(index.concepts, 'index.json.concepts', errors)) {
    index.concepts.forEach((concept, i) => {
      const where = `index.json.concepts[${i}]`
      if (requireString(concept.id, `${where}.id`, errors)) conceptIds.add(concept.id)
      requireString(concept.name, `${where}.name`, errors)
      requireString(concept.summary, `${where}.summary`, errors)
      requireEvidenceAndConfidence(concept, where, errors)
    })
  }

  if (requireArray(index.relationships, 'index.json.relationships', errors)) {
    index.relationships.forEach((relationship, i) => {
      const where = `index.json.relationships[${i}]`
      requireString(relationship.summary, `${where}.summary`, errors)
      if (!RELATIONSHIP_KIND.has(relationship.kind)) {
        errors.push(`${where}.kind must be one of ${[...RELATIONSHIP_KIND].join(', ')} (got ${JSON.stringify(relationship.kind)})`)
      }
      if ('cardinality' in relationship && !CARDINALITY.has(relationship.cardinality)) {
        errors.push(`${where}.cardinality must be one of ${[...CARDINALITY].join(', ')} (got ${JSON.stringify(relationship.cardinality)})`)
      }
      requireEvidenceAndConfidence(relationship, where, errors)
    })
  }

  if (requireArray(index.flows, 'index.json.flows', errors)) {
    index.flows.forEach((flow, i) => {
      const where = `index.json.flows[${i}]`
      requireString(flow.id, `${where}.id`, errors)
      requireString(flow.name, `${where}.name`, errors)
      requireArray(flow.steps, `${where}.steps`, errors)
      requireEvidenceAndConfidence(flow, where, errors)
    })
  }

  if (!requireArray(index.gaps, 'index.json.gaps', errors)) {
    return { fileIds, conceptIds }
  }

  // Second pass: now that every id is known, check that each reference resolves.
  if (Array.isArray(index.relationships)) {
    index.relationships.forEach((relationship, i) => {
      const where = `index.json.relationships[${i}]`
      for (const end of ['source', 'target']) {
        const id = relationship[end]
        if (typeof id !== 'string' || !conceptIds.has(id)) {
          errors.push(`${where}.${end} "${id}" is not a concept id`)
        }
      }
    })
  }

  if (Array.isArray(index.flows)) {
    index.flows.forEach((flow, i) => {
      if (!Array.isArray(flow.steps)) return
      flow.steps.forEach((step, j) => {
        if (typeof step !== 'string' || !conceptIds.has(step)) {
          errors.push(`index.json.flows[${i}].steps[${j}] "${step}" is not a concept id`)
        }
      })
    })
  }

  if (Array.isArray(index.concepts)) {
    index.concepts.forEach((concept, i) => {
      if (!Array.isArray(concept.ownerFileIds)) return
      concept.ownerFileIds.forEach((fileId, j) => {
        if (typeof fileId !== 'string' || !fileIds.has(fileId)) {
          errors.push(`index.json.concepts[${i}].ownerFileIds[${j}] "${fileId}" is not a file id`)
        }
      })
    })
  }

  return { fileIds, conceptIds }
}

export function checkHtml(html, conceptIds, errors = []) {
  CONCEPT_MARKER.lastIndex = 0
  const markers = new Set()
  let match
  while ((match = CONCEPT_MARKER.exec(html)) !== null) markers.add(match[1])

  if (markers.size === 0) {
    errors.push('architecture.html carries no data-concept-id; diagram nodes and detail entries must name their concept')
  }

  if (conceptIds) {
    for (const id of markers) {
      if (id === '') {
        errors.push('architecture.html has an empty data-concept-id')
      } else if (!conceptIds.has(id)) {
        errors.push(`architecture.html references concept "${id}", which is not in the index`)
      }
    }
    if (conceptIds.size > SEARCH_CONCEPT_THRESHOLD && !SEARCH_CONTROL.test(html)) {
      errors.push(`architecture.html has ${conceptIds.size} concepts but no search control (required above ${SEARCH_CONCEPT_THRESHOLD})`)
    }
  }

  if (DOWNLOAD_ATTRIBUTE.test(html) || ARCHIVE_LINK.test(html)) {
    errors.push('architecture.html offers a source-code download control; the report must stay read-only')
  }
}

export function paletteOf(html) {
  const root = html.match(/:root\s*\{([\s\S]*?)\}/)
  if (!root) return null
  const vars = {}
  for (const match of root[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[match[1].toLowerCase()] = match[2].trim().toLowerCase()
  }
  return Object.keys(vars).length ? vars : null
}

export function checkPalette(reportHtml, templateHtml, errors = []) {
  const expected = paletteOf(templateHtml)
  if (!expected) return

  const actual = paletteOf(reportHtml)
  if (!actual) {
    errors.push('architecture.html has no :root palette to compare against the report template')
    return
  }

  for (const [name, value] of Object.entries(expected)) {
    if (!(name in actual)) {
      errors.push(`architecture.html is missing palette variable ${name}; the template defines it as ${value}`)
    } else if (actual[name] !== value) {
      errors.push(`architecture.html sets ${name} to ${actual[name]}; the template defines ${value}`)
    }
  }
}

export async function checkSecrets(dir, errors = []) {
  for (const name of REQUIRED_FILES) {
    let contents
    try {
      contents = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(contents)) errors.push(`${name} looks like it contains a ${label}`)
    }
  }
}

export async function checkContextBudget(dir, present, errors = []) {
  if (!present['context.md']) return
  const info = await stat(join(dir, 'context.md'))
  if (info.size > MAX_CONTEXT_BYTES) {
    errors.push(`context.md is ${info.size} bytes; the budget is ${MAX_CONTEXT_BYTES} so it stays loadable whole`)
  }
}

export async function checkReport(target, options = {}) {
  const dir = resolve(target)
  let info
  try {
    info = await stat(dir)
  } catch {
    return { ok: false, dir, fatal: true, errors: [`report directory not found: ${dir}`] }
  }
  if (!info.isDirectory()) {
    return { ok: false, dir, fatal: true, errors: [`not a directory: ${dir}`] }
  }

  const errors = []
  const present = {}
  for (const name of REQUIRED_FILES) {
    try {
      await stat(join(dir, name))
      present[name] = true
    } catch {
      present[name] = false
      errors.push(`missing report file: ${name}`)
    }
  }

  let index = null
  if (present['index.json']) {
    const raw = await readFile(join(dir, 'index.json'), 'utf8')
    try {
      index = JSON.parse(raw)
    } catch (error) {
      errors.push(`index.json is not valid JSON: ${error.message}`)
    }
  }

  let conceptIds = null
  if (index) {
    if (!isPlainObject(index)) {
      errors.push('index.json must be an object')
    } else {
      conceptIds = checkIndex(index, errors).conceptIds
    }
  }

  if (present['architecture.html']) {
    const html = await readFile(join(dir, 'architecture.html'), 'utf8')
    checkHtml(html, conceptIds, errors)

    let templateHtml = options.templateHtml
    if (templateHtml === undefined) {
      const templatePath = options.templatePath || TEMPLATE_PATH
      try {
        templateHtml = await readFile(templatePath, 'utf8')
      } catch {
        templateHtml = null
      }
    }
    if (templateHtml) {
      checkPalette(html, templateHtml, errors)
    }
  }

  await checkSecrets(dir, errors)
  await checkContextBudget(dir, present, errors)

  return {
    ok: errors.length === 0,
    dir,
    errors,
  }
}

export async function cli(args = process.argv.slice(2)) {
  const target = args[0]
  if (!target) {
    console.error('usage: node scripts/check-report.mjs <report-dir>')
    process.exit(2)
  }

  const result = await checkReport(target)

  if (result.fatal) {
    console.error(result.errors[0])
    process.exit(2)
  }

  if (result.ok) {
    console.log(`report check passed: ${result.dir}`)
    return
  }

  console.error(`report check failed: ${result.dir}\n`)
  for (const error of result.errors) console.error(`  x ${error}`)
  console.error(`\n${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}`)
  process.exit(1)
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  await cli()
}
