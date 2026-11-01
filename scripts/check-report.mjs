#!/usr/bin/env node
/**
 * Check a codebase-map report directory against the report contract.
 *
 *   node scripts/check-report.mjs <report-dir>
 *
 * This module owns the mechanical half of SKILL.md's completion check: the
 * invariants a file can decide. The other half — whether the focused view
 * answers the question, whether captions are concise, whether the diagram reads
 * well — needs judgement and stays in SKILL.md as prose.
 *
 * The palette is compared against docs/report-template.html, which is its single
 * home, so a colour cannot silently diverge between the template and a report.
 * The layout numbers come from docs/diagram-geometry.md, which is the one place
 * that states them; here they only decide what a coordinate can decide.
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

  // A comment is not a control: the template's contract text names the very
  // things it forbids, so scan the markup the reader actually gets.
  const markup = html.replace(/<!--[\s\S]*?-->/g, ' ')
  if (DOWNLOAD_ATTRIBUTE.test(markup) || ARCHIVE_LINK.test(markup)) {
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

// Layout numbers, stated in docs/diagram-geometry.md. GLYPH_ADVANCE_EM is the
// average glyph advance of the template's font stack, which is what makes the
// label budget match the text a browser actually draws.
export const GLYPH_ADVANCE_EM = 0.54
export const LABEL_INSET = 16
export const CANVAS_PADDING = 20
export const ARROW_TOLERANCE = 8
export const FOOTPRINT_WIDTH = 132
export const FOOTPRINT_HEIGHT = 100

function attribute(el, name) {
  const match = el.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))
  return match ? match[1] : null
}

function numberAttribute(el, name) {
  const raw = attribute(el, name)
  if (raw === null) return NaN
  const value = parseFloat(raw)
  return Number.isFinite(value) ? value : NaN
}

function decodedText(raw) {
  return raw.replace(/&(?:[a-z]+|#\d+|#[xX][0-9a-fA-F]+);/g, 'x')
}

// Read the size from the report's own CSS. A label whose size the report does
// not state is a label the budget cannot be decided for, so it is skipped.
function fontSizeFor(html, className) {
  const rule = html.match(new RegExp(`\\.${className}\\s*\\{[^}]*font-size\\s*:\\s*([\\d.]+)px`))
  return rule ? parseFloat(rule[1]) : null
}

function labelWidth(chars, fontSize) {
  return chars * GLYPH_ADVANCE_EM * fontSize
}

function textExtent(text) {
  const anchor = text.anchor || 'start'
  const x = text.x
  const width = labelWidth(text.content.length, text.fontSize)
  if (anchor === 'middle') return { x1: x - width / 2, x2: x + width / 2 }
  if (anchor === 'end') return { x1: x - width, x2: x }
  return { x1: x, x2: x + width }
}

function viewBoxOf(svg) {
  const viewBox = attribute(svg, 'viewBox')
  if (!viewBox) return null
  const parts = viewBox.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null
  const [minX, minY, width, height] = parts
  return { minX, minY, maxX: minX + width, maxY: minY + height, width, height }
}

function segmentsOf(d) {
  const tokens = d.match(/[MLHVZmlhvz][^MLHVZmlhvz]*/g)
  if (!tokens) return null
  let cursorX = 0
  let cursorY = 0
  const segments = []
  for (const token of tokens) {
    const command = token[0]
    if (command !== command.toUpperCase()) return null
    if (command === 'Z') continue
    const args = (token.slice(1).match(/-?\d*\.?\d+/g) || []).map(Number)
    if (args.length === 0) return null
    let x = cursorX
    let y = cursorY
    if (command === 'M' || command === 'L') {
      ;[x, y] = args
    } else if (command === 'H') {
      x = args[0]
    } else {
      y = args[0]
    }
    // A moveto opens a subpath; it is not a drawn segment, so it cannot attach to
    // or cross anything.
    if (command !== 'M') {
      segments.push({ x1: cursorX, y1: cursorY, x2: x, y2: y, axis: command })
    }
    cursorX = x
    cursorY = y
  }
  return segments
}

function boxOf(rect) {
  return {
    x: numberAttribute(rect, 'x'),
    y: numberAttribute(rect, 'y'),
    width: numberAttribute(rect, 'width'),
    height: numberAttribute(rect, 'height'),
  }
}

function onBoundary(box, x, y) {
  const within = (value, low, high) => value >= low - ARROW_TOLERANCE && value <= high + ARROW_TOLERANCE
  const verticalSide = Math.abs(x - box.x) <= ARROW_TOLERANCE || Math.abs(x - (box.x + box.width)) <= ARROW_TOLERANCE
  const horizontalSide = Math.abs(y - box.y) <= ARROW_TOLERANCE || Math.abs(y - (box.y + box.height)) <= ARROW_TOLERANCE
  if (verticalSide && within(y, box.y, box.y + box.height)) return true
  if (horizontalSide && within(x, box.x, box.x + box.width)) return true
  return false
}

function crossesBox(x1, y1, x2, y2, box) {
  const left = Math.min(x1, x2)
  const right = Math.max(x1, x2)
  const top = Math.min(y1, y2)
  const bottom = Math.max(y1, y2)
  const boxLeft = box.x
  const boxRight = box.x + box.width
  const boxTop = box.y
  const boxBottom = box.y + box.height
  const isHorizontal = Math.abs(y1 - y2) < 0.01
  const isVertical = Math.abs(x1 - x2) < 0.01
  if (isHorizontal) {
    const y = y1
    return y > boxTop && y < boxBottom && left < boxRight && right > boxLeft
  }
  if (isVertical) {
    const x = x1
    return x > boxLeft && x < boxRight && top < boxBottom && bottom > boxTop
  }
  return left < boxRight && right > boxLeft && top < boxBottom && bottom > boxTop
}

function parseDiagram(svg, html) {
  const viewBox = viewBoxOf(svg)
  const title = svg.match(/<title[^>]*>([\s\S]*?)<\/title>/)
  const nodes = []
  const nodeBlocks = svg.match(/<a\b[\s\S]*?<\/a>/g) || []
  for (const block of nodeBlocks) {
    const rect = block.match(/<rect\b[^>]*class="[^"]*\btile\b[^"]*"[^>]*>/)
    if (!rect) continue
    // A node is a tile plus the label centred under it; the footprint, not the
    // tile, is what edges attach to and what must not overlap.
    const tile = boxOf(rect[0])
    const centre = tile.x + tile.width / 2
    const box = {
      x: centre - FOOTPRINT_WIDTH / 2,
      y: tile.y,
      width: FOOTPRINT_WIDTH,
      height: FOOTPRINT_HEIGHT,
      tile,
    }
    box.labels = []
    for (const match of block.matchAll(/<text\b[^>]*class="[^"]*\bnode-(title|subtitle)\b[^"]*"[^>]*>([^<]*)<\/text>/g)) {
      const kind = `node-${match[1]}`
      const fontSize = fontSizeFor(html, kind)
      if (fontSize === null) continue
      box.labels.push({ kind: match[1], chars: decodedText(match[2]).length, fontSize })
    }
    nodes.push(box)
  }

  const edges = []
  for (const match of svg.matchAll(/<path\b[^>]*class="[^"]*\bedge-[^"]*"[^>]*/g)) {
    const d = attribute(match[0], 'd')
    if (!d) continue
    edges.push({ d, segments: segmentsOf(d) })
  }

  const labels = []
  for (const match of svg.matchAll(/<text\b[^>]*class="[^"]*\b(edge-label|boundary-label)\b[^"]*"[^>]*>([^<]*)<\/text>/g)) {
    const kind = match[1]
    const fontSize = fontSizeFor(html, kind)
    if (fontSize === null) continue
    labels.push({
      content: decodedText(match[2]),
      fontSize,
      x: numberAttribute(match[0], 'x'),
      y: numberAttribute(match[0], 'y'),
      anchor: attribute(match[0], 'text-anchor') || 'start',
      kind,
    })
  }

  return { viewBox, name: title ? title[1].trim() : 'diagram', nodes, edges, labels }
}

export function checkLayout(html, errors = []) {
  const diagrams = html.match(/<svg\b(?![^>]*class="[^"]*icon)[^>]*>[\s\S]*?<\/svg>/g) || []
  if (diagrams.length === 0) return

  for (const svg of diagrams) {
    const { viewBox, name, nodes, edges, labels } = parseDiagram(svg, html)
    if (!viewBox) {
      errors.push(`${name}: diagram has no parsable viewBox; the fit rules need bounds`)
      continue
    }
    // A diagram whose nodes the parser cannot see would pass every rule below
    // by accident, so say so rather than reporting a clean picture.
    if (nodes.length === 0 && /class="[^"]*\bdiagram-node\b/.test(svg)) {
      errors.push(`${name}: diagram has diagram nodes but no <rect class="tile">; the node shape in docs/diagram-geometry.md is what the fit rules measure`)
      continue
    }

    const fits = (x1, x2, y1, y2, what) => {
      if (x1 < viewBox.minX + CANVAS_PADDING || x2 > viewBox.maxX - CANVAS_PADDING
        || y1 < viewBox.minY + CANVAS_PADDING || y2 > viewBox.maxY - CANVAS_PADDING) {
        errors.push(`${name}: ${what} runs past the viewBox padding; every element needs ${CANVAS_PADDING}px of margin inside 0 0 ${viewBox.width} ${viewBox.height}`)
      }
    }

    for (const node of nodes) {
      fits(node.x, node.x + node.width, node.y, node.y + node.height, `node at x=${node.x} y=${node.y}`)
      for (const label of node.labels) {
        const budget = Math.floor((node.width - LABEL_INSET) / (GLYPH_ADVANCE_EM * label.fontSize))
        if (label.chars > budget) {
          errors.push(`${name}: node at x=${node.x} gives ${label.kind} ${budget} characters at ${label.fontSize}px but holds ${label.chars}; shorten the label or move the detail to the evidence panel`)
        }
        const width = labelWidth(label.chars, label.fontSize)
        const centre = node.x + node.width / 2
        fits(centre - width / 2, centre + width / 2, node.y, node.y + node.height, `${label.kind} text`)
      }
    }

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        if (overlaps) {
          errors.push(`${name}: nodes at x=${a.x} y=${a.y} and x=${b.x} y=${b.y} overlap`)
        }
      }
    }

    for (const label of labels) {
      const { x1, x2 } = textExtent(label)
      fits(x1, x2, label.y - label.fontSize, label.y, `${label.kind} "${label.content}"`)
      for (const node of nodes) {
        const clearsVertically = label.y <= node.y || label.y - label.fontSize >= node.y + node.height
        const clearsHorizontally = x2 <= node.x || x1 >= node.x + node.width
        if (!clearsVertically && !clearsHorizontally) {
          errors.push(`${name}: label "${label.content}" sits on top of the node at x=${node.x} y=${node.y}`)
        }
      }
    }

    if (nodes.length < 2) continue

    for (const edge of edges) {
      if (!edge.segments || edge.segments.length === 0) continue
      const start = edge.segments[0]
      const finish = edge.segments[edge.segments.length - 1]
      const hasSource = nodes.some(node => onBoundary(node, start.x1, start.y1))
      const hasTarget = nodes.some(node => onBoundary(node, finish.x2, finish.y2))
      if (!hasSource || !hasTarget) {
        const missing = [!hasSource && 'source', !hasTarget && 'target'].filter(Boolean).join(' and ')
        errors.push(`${name}: edge "${edge.d}" is not attached to a node boundary at the ${missing}`)
      }

      for (const segment of edge.segments) {
        const shrink = ARROW_TOLERANCE
        const dx = segment.x2 - segment.x1
        const dy = segment.y2 - segment.y1
        const shorten = (axis) => {
          if (axis === 'M' || axis === 'L') {
            const length = Math.hypot(dx, dy)
            if (length <= shrink * 2) return null
            const ux = dx / length
            const uy = dy / length
            return {
              x1: segment.x1 + ux * shrink, y1: segment.y1 + uy * shrink,
              x2: segment.x2 - ux * shrink, y2: segment.y2 - uy * shrink,
            }
          }
          if (Math.abs(dx) < 0.01) {
            if (Math.abs(dy) <= shrink * 2) return null
            const sign = dy > 0 ? 1 : -1
            return { x1: segment.x1, y1: segment.y1 + sign * shrink, x2: segment.x2, y2: segment.y2 - sign * shrink }
          }
          if (Math.abs(dx) <= shrink * 2) return null
          const sign = dx > 0 ? 1 : -1
          return { x1: segment.x1 + sign * shrink, y1: segment.y1, x2: segment.x2 - sign * shrink, y2: segment.y2 }
        }
        const inner = shorten(segment.axis)
        if (!inner) continue
        for (const node of nodes) {
          if (crossesBox(inner.x1, inner.y1, inner.x2, inner.y2, node)) {
            errors.push(`${name}: edge "${edge.d}" runs through the node at x=${node.x} y=${node.y}; connect footprint boundaries, never across a node`)
          }
        }
      }
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
    checkLayout(html, errors)

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
