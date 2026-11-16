/**
 * Report Verifier: validate a Report Bundle against the Report Contract.
 *
 * One interface: verifyReport(bundle, { templateHtml, marks, geometry }).
 * Zero filesystem dependencies: the FileSystem Adapter
 * (scripts/check-report.mjs) loads every Report Contract asset and
 * passes the resolved values in, so this module decides only what a
 * bundle can decide. The palette is compared against the template,
 * which is its single home; the layout numbers come from
 * docs/diagram-geometry.json, explained in docs/diagram-geometry.md;
 * a tile's technology mark is compared against
 * docs/technology-marks.json, so a mark can only be a vendored one and
 * only where the index names that technology.
 *
 * Zero dependencies, so it runs anywhere Node runs.
 */


import { parseDiagrams } from './diagram-model.mjs'

export const REQUIRED_FILES = ['index.json', 'context.md', 'architecture.html', 'evidence.md']

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

function isPlainObject(value) {
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

function checkIndex(index, errors = []) {
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

function checkHtml(html, conceptIds, errors = []) {
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

function paletteOf(html) {
  const root = html.match(/:root\s*\{([\s\S]*?)\}/)
  if (!root) return null
  const vars = {}
  for (const match of root[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[match[1].toLowerCase()] = match[2].trim().toLowerCase()
  }
  return Object.keys(vars).length ? vars : null
}

function checkPalette(reportHtml, templateHtml, errors = []) {
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

function labelWidth(chars, fontSize, geometry) {
  return chars * geometry.glyphAdvanceEm * fontSize
}

function textExtent(text, geometry) {
  const anchor = text.anchor || 'start'
  const x = text.x
  const width = labelWidth(text.content.length, text.fontSize, geometry)
  if (anchor === 'middle') return { x1: x - width / 2, x2: x + width / 2 }
  if (anchor === 'end') return { x1: x - width, x2: x }
  return { x1: x, x2: x + width }
}

function onBoundary(box, x, y, geometry) {
  const within = (value, low, high) => value >= low - geometry.arrowTolerance && value <= high + geometry.arrowTolerance
  const verticalSide = Math.abs(x - box.x) <= geometry.arrowTolerance || Math.abs(x - (box.x + box.width)) <= geometry.arrowTolerance
  const horizontalSide = Math.abs(y - box.y) <= geometry.arrowTolerance || Math.abs(y - (box.y + box.height)) <= geometry.arrowTolerance
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

function checkLayout(diagrams, geometry, errors = []) {
  if (diagrams.length === 0) return

  for (const diagram of diagrams) {
    const { viewBox, name, nodes, edges, labels, raw } = diagram
    if (!viewBox) {
      errors.push(`${name}: diagram has no parsable viewBox; the fit rules need bounds`)
      continue
    }
    // A diagram whose nodes the parser cannot see would pass every rule below
    // by accident, so say so rather than reporting a clean picture.
    if (nodes.length === 0 && /class="[^"]*\bdiagram-node\b/.test(raw)) {
      errors.push(`${name}: diagram has diagram nodes but no <rect class="tile">; the node shape in docs/diagram-geometry.md is what the fit rules measure`)
      continue
    }

    const fits = (x1, x2, y1, y2, what) => {
      if (x1 < viewBox.minX + geometry.canvasPadding || x2 > viewBox.maxX - geometry.canvasPadding
        || y1 < viewBox.minY + geometry.canvasPadding || y2 > viewBox.maxY - geometry.canvasPadding) {
        errors.push(`${name}: ${what} runs past the viewBox padding; every element needs ${geometry.canvasPadding}px of margin inside 0 0 ${viewBox.width} ${viewBox.height}`)
      }
    }

    for (const node of nodes) {
      fits(node.x, node.x + node.width, node.y, node.y + node.height, `node at x=${node.x} y=${node.y}`)
      for (const label of node.labels) {
        const budget = Math.floor((node.width - geometry.labelInset) / (geometry.glyphAdvanceEm * label.fontSize))
        if (label.chars > budget) {
          errors.push(`${name}: node at x=${node.x} gives ${label.kind} ${budget} characters at ${label.fontSize}px but holds ${label.chars}; shorten the label or move the detail to the evidence panel`)
        }
        const width = labelWidth(label.chars, label.fontSize, geometry)
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
      const { x1, x2 } = textExtent(label, geometry)
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
      const hasSource = nodes.some(node => onBoundary(node, start.x1, start.y1, geometry))
      const hasTarget = nodes.some(node => onBoundary(node, finish.x2, finish.y2, geometry))
      if (!hasSource || !hasTarget) {
        const missing = [!hasSource && 'source', !hasTarget && 'target'].filter(Boolean).join(' and ')
        errors.push(`${name}: edge "${edge.d}" is not attached to a node boundary at the ${missing}`)
      }

      for (const segment of edge.segments) {
        const shrink = geometry.arrowTolerance
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

// Every string the index states, lower-cased — the text a mark has to earn its
// place in. Paths, names, summaries, evidence, and gaps all count; nothing in
// the report itself does.
function indexText(index) {
  const parts = []
  const walk = (value) => {
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (isPlainObject(value)) Object.values(value).forEach(walk)
  }
  walk(index)
  return parts.join('\n').toLowerCase()
}

const WORD_CHAR = /[a-z0-9]/

// "react" backs React; "reactive" does not. Keywords end in a separator
// (".github/workflows", "node.js") match on their own.
function namesToken(text, token) {
  let from = 0
  for (;;) {
    const at = text.indexOf(token, from)
    if (at === -1) return false
    const before = at === 0 ? '' : text[at - 1]
    const after = text[at + token.length] || ''
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true
    from = at + 1
  }
}

function detectTechnologies(index, marks) {
  if (!marks || !marks.marks) return new Set()
  const text = indexText(index)
  const backed = new Set()
  for (const mark of marks.marks) {
    if (mark.keywords.some(token => namesToken(text, token.toLowerCase()))) backed.add(mark.slug)
  }
  return backed
}

function normalizedPath(d) {
  return d.replace(/\s+/g, ' ').trim()
}

// A mark is borrowed identity, so it is checked three ways: it must be a real
// slug, drawn from the vendored path, in the ink the template sets, placed
// inside its tile, and — the rule that keeps the map honest — named by the
// index rather than assumed from how the repository looks.
function checkMarks(diagrams, errors = [], marks = null, backed = null) {
  const bySlug = marks && marks.marks ? new Map(marks.marks.map(m => [m.slug, m])) : null

  for (const { name, nodes } of diagrams) {
    for (const node of nodes) {
      const { tile, logo, kindCode } = node

      if (!logo) {
        if (!kindCode) {
          errors.push(`${name}: the tile at x=${tile.x} y=${tile.y} carries neither a technology mark nor a kind code`)
        }
        continue
      }

      if (kindCode) {
        errors.push(`${name}: the tile at x=${tile.x} y=${tile.y} carries both a technology mark and a kind code; a tile shows one`)
      }

      const slug = logo.slug
      if (!slug) {
        errors.push(`${name}: a tile-logo has no data-tech; the check cannot tell which technology it claims`)
        continue
      }

      if (!bySlug) {
        errors.push(`${name}: report draws the "${slug}" mark but docs/technology-marks.json was not read; the path cannot be verified`)
        continue
      }

      const mark = bySlug.get(slug)
      if (!mark) {
        errors.push(`${name}: "${slug}" is not a mark in docs/technology-marks.json; use a vendored slug or the kind code`)
        continue
      }

      if (logo.hasColour) {
        errors.push(`${name}: the "${slug}" mark carries its own colour; the template sets one ink for every mark and a brand path is never recoloured`)
      }

      if (!logo.path) {
        errors.push(`${name}: the "${slug}" mark has no <path d>; copy the vendored path into it`)
      } else if (normalizedPath(logo.path) !== normalizedPath(mark.path)) {
        errors.push(`${name}: the "${slug}" mark is not the path in docs/technology-marks.json; copy it verbatim or drop the mark`)
      }

      if (backed && !backed.has(slug)) {
        errors.push(`${name}: the "${slug}" mark is not backed by index.json; name the technology in the evidence or use the kind code`)
      }

      const placed = logo.placed
      const box = marks && marks.box ? marks.box : 24
      if (!placed) {
        errors.push(`${name}: the "${slug}" mark needs a transform that places its ${box}x${box} path inside the tile; docs/diagram-geometry.md gives translate and scale`)
      } else {
        const size = box * placed.scale
        const inside = placed.x >= tile.x && placed.y >= tile.y
          && placed.x + size <= tile.x + tile.width && placed.y + size <= tile.y + tile.height
        if (!inside) {
          errors.push(`${name}: the "${slug}" mark covers x=${placed.x} y=${placed.y} ${size}x${size}, which is not inside its tile at x=${tile.x} y=${tile.y} ${tile.width}x${tile.height}`)
        }
      }
    }
  }
}

function checkSecrets(bundle, errors = []) {
  for (const name of REQUIRED_FILES) {
    const contents = bundle[name]
    if (typeof contents !== 'string') continue
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(contents)) errors.push(`${name} looks like it contains a ${label}`)
    }
  }
}

function checkContextBudget(bundle, errors = []) {
  const content = bundle['context.md']
  if (content === undefined || content === null) return
  const size = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0
  if (size > MAX_CONTEXT_BYTES) {
    errors.push(`context.md is ${size} bytes; the budget is ${MAX_CONTEXT_BYTES} so it stays loadable whole`)
  }
}

export function verifyReport(bundle, options = {}) {
  const errors = []

  if (!isPlainObject(bundle)) {
    return { ok: false, errors: ['report bundle must be an object'] }
  }

  for (const name of REQUIRED_FILES) {
    if (bundle[name] === undefined || bundle[name] === null) {
      errors.push(`missing report file: ${name}`)
    }
  }

  let index = null
  if (bundle['index.json'] !== undefined && bundle['index.json'] !== null) {
    const raw = bundle['index.json']
    if (typeof raw === 'string') {
      try {
        index = JSON.parse(raw)
      } catch (error) {
        errors.push(`index.json is not valid JSON: ${error.message}`)
      }
    } else if (isPlainObject(raw)) {
      index = raw
    } else {
      errors.push('index.json must be an object')
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

  if (typeof bundle['architecture.html'] === 'string') {
    const html = bundle['architecture.html']
    checkHtml(html, conceptIds, errors)

    const geometry = options.geometry
    if (!geometry) {
      errors.push('diagram geometry was not supplied; layout cannot be verified against docs/diagram-geometry.json')
    }
    const diagrams = parseDiagrams(html, geometry || {})
    if (geometry) checkLayout(diagrams, geometry, errors)

    const marks = options.marks ?? null
    checkMarks(diagrams, errors, marks, index ? detectTechnologies(index, marks) : null)

    const templateHtml = options.templateHtml
    if (!templateHtml) {
      errors.push('report template was not supplied; palette cannot be verified against docs/report-template.html')
    } else {
      checkPalette(html, templateHtml, errors)
    }
  }

  checkSecrets(bundle, errors)
  checkContextBudget(bundle, errors)

  return {
    ok: errors.length === 0,
    errors,
  }
}
