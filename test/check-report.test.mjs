import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  verifyReport,
  checkReport,
  parseDiagrams,
  REQUIRED_FILES,
  SEARCH_CONCEPT_THRESHOLD,
  MAX_CONTEXT_BYTES,
} from '../scripts/check-report.mjs'

// --- Minimal Valid Fixtures ------------------------------------------------

const VALID_INDEX = {
  schemaVersion: 1,
  repository: { name: 'test' },
  files: [
    {
      id: 'f1',
      path: 'src/main.ts',
      summary: 'Entrypoint',
      kind: 'source',
      evidence: ['src/main.ts:1'],
      confidence: 'confirmed',
      symbols: ['main'],
    },
  ],
  concepts: [
    {
      id: 'concept-a',
      name: 'Concept A',
      summary: 'First concept',
      evidence: ['src/main.ts:1'],
      confidence: 'confirmed',
      ownerFileIds: ['f1'],
    },
    {
      id: 'concept-b',
      name: 'Concept B',
      summary: 'Second concept',
      evidence: ['src/main.ts:10'],
      confidence: 'confirmed',
      ownerFileIds: ['f1'],
    },
  ],
  relationships: [
    {
      source: 'concept-a',
      target: 'concept-b',
      kind: 'calls',
      summary: 'Calls concept B',
      evidence: ['src/main.ts:5'],
      confidence: 'confirmed',
    },
  ],
  flows: [
    {
      id: 'flow-1',
      name: 'Test flow',
      steps: ['concept-a', 'concept-b'],
      evidence: ['src/main.ts:1'],
      confidence: 'confirmed',
    },
  ],
  gaps: [],
}

const VALID_PALETTE = `:root {
  --canvas: #f6f7f9;
  --paper: #ffffff;
  --rule: #e4e8ee;
  --surface: #ffffff;
  --surface-raised: #f2f4f7;
  --text: #1b2028;
  --muted: #5d6773;
  --line: #8a94a3;
  --line-soft: #dfe3e9;
  --focus: #4d7c0f;
  --focus-ink: #3c620b;
  --focus-wash: #f0f6e2;
  --group-wash: #eef2f7;
  --group-line: #cfd8e4;
  --mark-ink: #3f4854;
  --radius: 10px;
  --tile-radius: 12px;
  --mono: ui-monospace, sfmono-regular, consolas, monospace;
}`

const DIAGRAM_CSS = `<style>
  ${VALID_PALETTE}
  .node-title { font-size: 13px; }
  .node-subtitle { font-size: 11px; }
  .edge-label { font-size: 11px; }
  .boundary-label { font-size: 12px; }
</style>`

function node(id, { cx, tileY, title, subtitle, mark = 'FN', logo = null, both = false }) {
  const showCode = logo ? both : mark !== null
  const code = showCode
    ? `\n    <text class="tile-mark" x="${cx}" y="${tileY + 37}" text-anchor="middle">${mark}</text>` : ''
  const face = `${code}${logo ? `\n    ${logo}` : ''}`
  return `<a class="diagram-node" href="#detail-${id}" data-concept-id="concept-${id}">
    <rect class="tile tile-focus" x="${cx - 30}" y="${tileY}" width="60" height="60" rx="12"></rect>${face}
    <text class="node-title" x="${cx}" y="${tileY + 78}" text-anchor="middle">${title}</text>
    <text class="node-subtitle" x="${cx}" y="${tileY + 96}" text-anchor="middle">${subtitle}</text>
  </a>`
}

const PAIR = node('a', { cx: 120, tileY: 90, title: 'Record request', subtitle: 'id: string' })
  + node('b', { cx: 300, tileY: 90, title: 'Handler', subtitle: 'handleRequest' })

function diagram(body, { viewBox = '0 0 1040 240', title = 'Probe view', css = DIAGRAM_CSS, palette = true, markers = true } = {}) {
  const pal = palette && !css.includes('--canvas') ? `<style>${VALID_PALETTE}</style>` : ''
  const markHtml = markers ? '<div data-concept-id="concept-a"></div><div data-concept-id="concept-b"></div>' : ''
  return `${pal}${css}${markHtml}<svg class="diagram" viewBox="${viewBox}" role="group"><title>${title}</title>${body}</svg>`
}

const VALID_HTML = diagram(PAIR + '<path class="edge-focus" d="M186 120 H234"/>')

function validBundle(overrides = {}) {
  return {
    'index.json': JSON.stringify(VALID_INDEX),
    'architecture.html': VALID_HTML,
    'context.md': '# Orientation\n\nValid context within budget.',
    'evidence.md': '# Evidence\n\nClaims and sources.',
    ...overrides,
  }
}

async function verifyErrors(bundle, options = {}) {
  const result = await verifyReport(bundle, options)
  return result.errors
}

// --- Contract Constants & CLI Adapter Tests --------------------------------

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

// --- In-Memory verifyReport: Bundle Structure -------------------------------

test('verifyReport: passes on a valid report bundle', async () => {
  const result = await verifyReport(validBundle())
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('verifyReport: flags non-object bundle and missing required files', async () => {
  const nonObject = await verifyReport('not-a-bundle')
  assert.equal(nonObject.ok, false)
  assert.ok(nonObject.errors.some(e => e.includes('report bundle must be an object')))

  const missingFiles = await verifyReport({})
  assert.equal(missingFiles.ok, false)
  for (const name of REQUIRED_FILES) {
    assert.ok(missingFiles.errors.some(e => e.includes(`missing report file: ${name}`)))
  }
})

// --- In-Memory verifyReport: Index Validation -------------------------------

test('verifyReport: catches missing schemaVersion and repository in index.json', async () => {
  const errors = await verifyErrors(validBundle({ 'index.json': {} }))
  assert.ok(errors.some(e => e.includes('missing a numeric schemaVersion')))
  assert.ok(errors.some(e => e.includes('index.json.repository must be an object')))
})

test('verifyReport: catches invalid JSON in index.json', async () => {
  const errors = await verifyErrors(validBundle({ 'index.json': '{ invalid json }' }))
  assert.ok(errors.some(e => e.includes('index.json is not valid JSON')))
})

test('verifyReport: validates files, evidence, and confidence in index.json', async () => {
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
  const errors = await verifyErrors(validBundle({ 'index.json': invalidIndex }))
  assert.ok(errors.some(e => e.includes('must be one of source, test, config, docs, asset, generated')))
  assert.ok(errors.some(e => e.includes('evidence is empty; every material entry needs a source')))
  assert.ok(errors.some(e => e.includes('confidence must be one of confirmed, inferred, unknown')))
})

test('verifyReport: catches unresolved concept references in relationships and flows', async () => {
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
        steps: ['concept-a', 'missing-step-concept'],
        evidence: ['a.ts:3'],
        confidence: 'confirmed',
      },
    ],
    gaps: [],
  }
  const errors = await verifyErrors(validBundle({ 'index.json': index }))
  assert.ok(errors.some(e => e.includes('ownerFileIds[0] "unknown-file-id" is not a file id')))
  assert.ok(errors.some(e => e.includes('target "ghost-concept" is not a concept id')))
  assert.ok(errors.some(e => e.includes('steps[1] "missing-step-concept" is not a concept id')))
})

// --- In-Memory verifyReport: HTML & Concept Markers -------------------------

test('verifyReport: flags missing or empty data-concept-id in architecture.html', async () => {
  const noMarkersErrors = await verifyErrors(validBundle({ 'architecture.html': '<style>' + VALID_PALETTE + '</style><div><span>no concepts here</span></div>' }))
  assert.ok(noMarkersErrors.some(e => e.includes('carries no data-concept-id')))

  const emptyMarkerErrors = await verifyErrors(validBundle({ 'architecture.html': '<style>' + VALID_PALETTE + '</style><div data-concept-id=""></div>' }))
  assert.ok(emptyMarkerErrors.some(e => e.includes('empty data-concept-id')))

  const unknownMarkerErrors = await verifyErrors(validBundle({ 'architecture.html': '<style>' + VALID_PALETTE + '</style><div data-concept-id="unregistered"></div>' }))
  assert.ok(unknownMarkerErrors.some(e => e.includes('references concept "unregistered", which is not in the index')))
})

test('verifyReport: enforces search control threshold (> 10 concepts)', async () => {
  const manyConcepts = Array.from({ length: 11 }, (_, i) => ({
    id: `c${i}`,
    name: `Concept ${i}`,
    summary: `Concept ${i} summary`,
    evidence: ['src/main.ts:1'],
    confidence: 'confirmed',
  }))
  const indexWithManyConcepts = {
    ...VALID_INDEX,
    concepts: manyConcepts,
    relationships: [],
    flows: [],
  }
  const htmlWithoutSearch = '<style>' + VALID_PALETTE + '</style>' + manyConcepts.map(c => `<div data-concept-id="${c.id}"></div>`).join('')
  const errorsWithoutSearch = await verifyErrors(validBundle({
    'index.json': indexWithManyConcepts,
    'architecture.html': htmlWithoutSearch,
  }))
  assert.ok(errorsWithoutSearch.some(e => e.includes(`has 11 concepts but no search control (required above ${SEARCH_CONCEPT_THRESHOLD})`)))

  const htmlWithSearch = '<input type="search" />' + htmlWithoutSearch
  const errorsWithSearch = await verifyErrors(validBundle({
    'index.json': indexWithManyConcepts,
    'architecture.html': htmlWithSearch,
  }))
  assert.equal(errorsWithSearch.filter(e => e.includes('search control')).length, 0)
})

test('verifyReport: rejects download attributes and archive links', async () => {
  const downloadHtml = diagram(PAIR + '<path class="edge-focus" d="M186 120 H234"/>') + '<a href="data.json" download>Download</a>'
  const downloadErrors = await verifyErrors(validBundle({ 'architecture.html': downloadHtml }))
  assert.ok(downloadErrors.some(e => e.includes('offers a source-code download control')))

  const archiveHtml = diagram(PAIR + '<path class="edge-focus" d="M186 120 H234"/>') + '<a href="archive.zip">Code</a>'
  const archiveErrors = await verifyErrors(validBundle({ 'architecture.html': archiveHtml }))
  assert.ok(archiveErrors.some(e => e.includes('offers a source-code download control')))
})

test('verifyReport: reads a comment as prose, not as a control', async () => {
  const commentHtml = diagram(PAIR + '<path class="edge-focus" d="M186 120 H234"/>') + '<!-- the template forbids a download control -->'
  const errors = await verifyErrors(validBundle({ 'architecture.html': commentHtml }))
  assert.deepEqual(errors, [])
})

// --- In-Memory verifyReport: Palette Verification ---------------------------

test('verifyReport: detects missing or mismatched palette variables', async () => {
  const template = `:root { --canvas: #17191d; --focus: #c9f36b; }`

  const validHtml = diagram(PAIR + '<path class="edge-focus" d="M186 120 H234"/>', {
    css: `<style>:root { --canvas: #17191d; --focus: #c9f36b; }</style>`,
    palette: false,
  })
  const validErrors = await verifyErrors(validBundle({ 'architecture.html': validHtml }), { templateHtml: template })
  assert.deepEqual(validErrors.filter(e => e.includes('palette')), [])

  const missingVarHtml = diagram(PAIR + '<path class="edge-focus" d="M186 120 H234"/>', {
    css: `<style>:root { --canvas: #17191d; }</style>`,
    palette: false,
  })
  const missingVarErrors = await verifyErrors(validBundle({ 'architecture.html': missingVarHtml }), { templateHtml: template })
  assert.ok(missingVarErrors.some(e => e.includes('missing palette variable --focus')))

  const mismatchedHtml = diagram(PAIR + '<path class="edge-focus" d="M186 120 H234"/>', {
    css: `<style>:root { --canvas: #ffffff; --focus: #c9f36b; }</style>`,
    palette: false,
  })
  const mismatchedErrors = await verifyErrors(validBundle({ 'architecture.html': mismatchedHtml }), { templateHtml: template })
  assert.ok(mismatchedErrors.some(e => e.includes('sets --canvas to #ffffff; the template defines #17191d')))

  const noPaletteHtml = diagram(PAIR + '<path class="edge-focus" d="M186 120 H234"/>', {
    css: ``,
    palette: false,
  })
  const noPaletteErrors = await verifyErrors(validBundle({ 'architecture.html': noPaletteHtml }), { templateHtml: template })
  assert.ok(noPaletteErrors.some(e => e.includes('has no :root palette')))
})

// --- In-Memory verifyReport: Secrets & Context Budget -----------------------

test('verifyReport: flags credentials and secret patterns in-memory', async () => {
  const errors = await verifyErrors(validBundle({ 'context.md': 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' }))
  assert.ok(errors.some(e => e.includes('context.md looks like it contains a GitHub token')))
})

test('verifyReport: flags context.md exceeding byte limit in-memory', async () => {
  const oversizedContent = 'x'.repeat(MAX_CONTEXT_BYTES + 10)
  const errors = await verifyErrors(validBundle({ 'context.md': oversizedContent }))
  assert.ok(errors.some(e => e.includes(`the budget is ${MAX_CONTEXT_BYTES}`)))
})

// --- In-Memory verifyReport: Diagram Layout Geometry ------------------------

test('verifyReport: accepts the example\'s own coordinates', async () => {
  const html = diagram(PAIR + '<path class="edge-focus" d="M186 120 H234" marker-end="url(#a)"/>')
  assert.deepEqual(await verifyErrors(validBundle({ 'architecture.html': html })), [])
})

test('verifyReport: accepts a vertical edge that leaves below its own label', async () => {
  const indexWithC = {
    ...VALID_INDEX,
    concepts: [
      ...VALID_INDEX.concepts,
      { id: 'concept-c', name: 'Store', summary: 'Storage', evidence: ['src/main.ts:20'], confidence: 'confirmed' },
    ],
  }
  const html = diagram(
    PAIR + node('c', { cx: 120, tileY: 250, title: 'Store', subtitle: 'records.json', mark: 'DB' })
      + '<path class="edge-muted" d="M120 190 V250" marker-end="url(#a)"/>',
    { viewBox: '0 0 1040 400' },
  )
  assert.deepEqual(await verifyErrors(validBundle({ 'index.json': indexWithC, 'architecture.html': html })), [])
})

test('verifyReport: passes over the committed example report architecture.html', async () => {
  const html = await readFile('examples/tiny-app/reports/codebase-map/tiny-app/architecture.html', 'utf8')
  const index = JSON.parse(await readFile('examples/tiny-app/reports/codebase-map/tiny-app/index.json', 'utf8'))
  const errors = await verifyErrors(validBundle({ 'index.json': index, 'architecture.html': html }))
  assert.deepEqual(errors, [])
})

test('verifyReport: flags a node running past the viewBox padding', async () => {
  const html = diagram(node('a', { cx: 980, tileY: 90, title: 'Wide node here', subtitle: 'database.read' }))
  const errors = await verifyErrors(validBundle({ 'architecture.html': html }))
  assert.ok(errors.some(e => e.includes('runs past the viewBox padding')))
})

test('verifyReport: flags a title over the character budget', async () => {
  const html = diagram(node('a', { cx: 120, tileY: 90, title: 'Extremely long title', subtitle: 'id' }))
  const errors = await verifyErrors(validBundle({ 'architecture.html': html }))
  assert.ok(errors.some(e => e.includes('gives title 16 characters at 13px but holds 20')))
})

test('verifyReport: flags overlapping nodes', async () => {
  const html = diagram(PAIR.replace('x="270"', 'x="134"'))
  const errors = await verifyErrors(validBundle({ 'architecture.html': html }))
  assert.ok(errors.some(e => e.includes('overlap')))
})

test('verifyReport: flags an edge that starts in thin air', async () => {
  const html = diagram(PAIR + '<path class="edge-focus" d="M200 120 H234"/>')
  const errors = await verifyErrors(validBundle({ 'architecture.html': html }))
  assert.ok(errors.some(e => e.includes('not attached to a node boundary at the source')))
})

test('verifyReport: flags an edge running through a node it does not connect', async () => {
  const indexWithC = {
    ...VALID_INDEX,
    concepts: [
      ...VALID_INDEX.concepts,
      { id: 'concept-c', name: 'Repository', summary: 'Repo', evidence: ['src/main.ts:20'], confidence: 'confirmed' },
    ],
  }
  const third = node('c', { cx: 480, tileY: 90, title: 'Repository', subtitle: 'repository.find', mark: 'DB' })
  const html = diagram(PAIR + third + '<path class="edge-muted" d="M186 120 H414"/>')
  const errors = await verifyErrors(validBundle({ 'index.json': indexWithC, 'architecture.html': html }))
  assert.ok(errors.some(e => e.includes('runs through the node at x=234 y=90')))
})

test('verifyReport: flags an edge label sitting on a node footprint', async () => {
  const html = diagram(PAIR + '<text class="edge-label" x="300" y="140" text-anchor="middle">read</text>')
  const errors = await verifyErrors(validBundle({ 'architecture.html': html }))
  assert.ok(errors.some(e => e.includes('label "read" sits on top of the node at x=234 y=90')))
})

test('verifyReport: flags a diagram without a usable viewBox', async () => {
  const html = diagram(PAIR, { viewBox: 'nope' })
  const errors = await verifyErrors(validBundle({ 'architecture.html': html }))
  assert.ok(errors.some(e => e.includes('no parsable viewBox')))
})

test('verifyReport: skips a label budget it has no type size for', async () => {
  const html = diagram(node('a', { cx: 120, tileY: 90, title: 'Extremely long title', subtitle: 'id' }), { css: '' })
  const errors = await verifyErrors(validBundle({ 'architecture.html': html }))
  assert.deepEqual(errors.filter(e => e.includes('characters')), [])

  const collision = diagram(PAIR + '<text class="edge-label" x="300" y="140" text-anchor="middle">read</text>', { css: '' })
  const collisionErrors = await verifyErrors(validBundle({ 'architecture.html': collision }))
  assert.deepEqual(collisionErrors.filter(e => e.includes('sits on top of the node')), [])
})

test('verifyReport: reads the type size the report states, not a constant', async () => {
  const wide = diagram(
    node('a', { cx: 120, tileY: 90, title: 'Extremely long title', subtitle: 'id' }),
    { css: '<style>.node-title{font-size:9px}.node-subtitle{font-size:11px}</style>' },
  )
  const errors = await verifyErrors(validBundle({ 'architecture.html': wide }))
  assert.deepEqual(errors.filter(e => e.includes('characters')), [])
})

test('verifyReport: flags a diagram whose nodes it cannot see', async () => {
  const boxes = '<a class="diagram-node" data-concept-id="concept-a"><rect class="node-focus" x="38" y="90" width="126" height="64"></rect></a>'
  const errors = await verifyErrors(validBundle({ 'architecture.html': diagram(boxes) }))
  assert.ok(errors.some(e => e.includes('no <rect class="tile">')))
})

test('verifyReport: skips geometry it cannot decide', async () => {
  const relative = diagram(PAIR + '<path class="edge-focus" d="m186 120 h48"/>')
  assert.deepEqual(await verifyErrors(validBundle({ 'architecture.html': relative })), [])

  const curved = diagram(PAIR + '<path class="edge-focus" d="M186 120 C210 120 210 120 234 120"/>')
  assert.deepEqual(await verifyErrors(validBundle({ 'architecture.html': curved })), [])

  const lone = diagram(node('a', { cx: 120, tileY: 90, title: 'Record request', subtitle: 'id' }))
  assert.deepEqual(await verifyErrors(validBundle({ 'architecture.html': lone })), [])
})

// --- In-Memory verifyReport: Technology Marks -------------------------------

const MARKS = {
  box: 24,
  marks: [
    { slug: 'react', name: 'React', keywords: ['react'], path: 'M0 0 H24 V24 Z' },
    { slug: 'postgresql', name: 'PostgreSQL', keywords: ['postgres', 'postgresql'], path: 'M4 4 L20 20' },
    { slug: 'githubactions', name: 'GitHub Actions', keywords: ['github actions', '.github/workflows'], path: 'M1 1 H23 V23 Z' },
  ],
}

const REACT_INDEX = {
  schemaVersion: 1,
  repository: { name: 'probe' },
  files: [{ id: 'f1', path: 'src/view.tsx', kind: 'source', summary: 'Renders the react record', evidence: ['src/view.tsx:2'], confidence: 'confirmed', symbols: [] }],
  concepts: [
    { id: 'concept-a', name: 'Main view', summary: 'Shows the record', evidence: ['src/view.tsx:2'], confidence: 'confirmed' },
    { id: 'concept-b', name: 'Handler', summary: 'Handler func', evidence: ['src/view.tsx:2'], confidence: 'confirmed' },
  ],
  relationships: [],
  flows: [],
  gaps: [],
}

function logo({ cx = 120, tileY = 90, slug = 'react', path = 'M0 0 H24 V24 Z', transform, colour } = {}) {
  const placed = transform || `translate(${cx - 15} ${tileY + 15}) scale(1.25)`
  const tint = colour ? ` fill="${colour}"` : ''
  return `    <g class="tile-logo" data-tech="${slug}"${tint} transform="${placed}"><path d="${path}"></path></g>`
}

test('verifyReport: accepts a mark the index names, drawn as vendored', async () => {
  const html = diagram(node('a', { cx: 120, tileY: 90, title: 'Record request', subtitle: 'id' })
    + node('b', { cx: 300, tileY: 90, title: 'Handler', subtitle: 'handleRequest', logo: logo({ cx: 300 }) }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.deepEqual(errors, [])
})

test('verifyReport: flags a mark the index does not name', async () => {
  const html = diagram(node('b', { cx: 120, tileY: 90, title: 'Store', subtitle: 'records', logo: logo({ slug: 'postgresql', path: 'M4 4 L20 20' }) }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.ok(errors.some(e => e.includes('"postgresql" mark is not backed by index.json')))
})

test('verifyReport: flags a slug that is not vendored', async () => {
  const html = diagram(node('b', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', logo: logo({ slug: 'svelte' }) }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.ok(errors.some(e => e.includes('"svelte" is not a mark in docs/technology-marks.json')))
})

test('verifyReport: flags a path that was redrawn rather than copied', async () => {
  const html = diagram(node('b', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', logo: logo({ path: 'M0 0 H12 V12 Z' }) }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.ok(errors.some(e => e.includes('"react" mark is not the path in docs/technology-marks.json')))
})

test('verifyReport: flags a recoloured mark', async () => {
  const html = diagram(node('b', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', logo: logo({ colour: '#61DAFB' }) }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.ok(errors.some(e => e.includes('carries its own colour')))
})

test('verifyReport: flags a mark that overruns its tile', async () => {
  const html = diagram(node('b', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', logo: logo({ transform: 'translate(20 20) scale(4)' }) }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.ok(errors.some(e => e.includes('which is not inside its tile at x=90 y=90')))
})

test('verifyReport: flags a mark whose placement it cannot read', async () => {
  const html = diagram(node('b', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', logo: logo({ transform: 'rotate(12)' }) }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.ok(errors.some(e => e.includes('needs a transform that places its 24x24 path inside the tile')))
})

test('verifyReport: flags a tile carrying a mark and a kind code', async () => {
  const html = diagram(node('b', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', logo: logo(), both: true }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.ok(errors.some(e => e.includes('carries both a technology mark and a kind code')))
})

test('verifyReport: flags a tile carrying neither', async () => {
  const html = diagram(node('b', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', mark: null }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.ok(errors.some(e => e.includes('neither a technology mark nor a kind code')))
})

test('verifyReport: flags a mark whose slug is missing', async () => {
  const bare = '    <g class="tile-logo" transform="translate(285 105) scale(1.25)"><path d="M0 0 H24 V24 Z"></path></g>'
  const html = diagram(node('b', { cx: 300, tileY: 90, title: 'Handler', subtitle: 'handler', logo: bare }))
  const errors = await verifyErrors(validBundle({ 'index.json': REACT_INDEX, 'architecture.html': html }), { marks: MARKS })
  assert.ok(errors.some(e => e.includes('has no data-tech')))
})

test('verifyReport: matches tokens, not substrings for technology backing', async () => {
  const probe = (text) => ({
    ...REACT_INDEX,
    files: [{ id: 'f1', path: text, kind: 'source', summary: text, evidence: ['a:1'], confidence: 'confirmed', symbols: [] }],
  })
  const html = diagram(node('b', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', logo: logo({ slug: 'react' }) }))

  // "src/react.tsx" has "react" token -> valid
  const matchErrors = await verifyErrors(validBundle({ 'index.json': probe('src/react.tsx'), 'architecture.html': html }), { marks: MARKS })
  assert.deepEqual(matchErrors.filter(e => e.includes('"react" mark is not backed')), [])

  // "reactive form state" has "reactive" (substring only) -> flagged
  const nonMatchErrors = await verifyErrors(validBundle({ 'index.json': probe('reactive form state'), 'architecture.html': html }), { marks: MARKS })
  assert.ok(nonMatchErrors.some(e => e.includes('"react" mark is not backed by index.json')))
})

// --- Asset Verification: technology-marks.json ------------------------------

test('technology marks asset: every mark is vendored and complete', async () => {
  const marks = JSON.parse(await readFile(new URL('../docs/technology-marks.json', import.meta.url), 'utf8'))
  assert.equal(marks.box, 24)
  assert.ok(marks.marks.length >= 15, 'the set should cover the stacks a scan usually names')
  const slugs = marks.marks.map(mark => mark.slug)
  assert.equal(new Set(slugs).size, slugs.length)
  for (const mark of marks.marks) {
    assert.ok(mark.name.length > 0)
    assert.ok(mark.keywords.length > 0 && mark.keywords.every(k => k.length > 2))
    assert.match(mark.path, /^M-?[\d.]/)
    assert.doesNotMatch(mark.path, /\s\s/, `${mark.slug} path is not normalised`)
  }
})

// --- Synchronous In-Memory Seam & Diagram Model Tests -----------------------

test('verifyReport: is fully synchronous and requires no options for default contract', () => {
  const bundle = validBundle()
  const result = verifyReport(bundle)
  assert.equal(typeof result.then, 'undefined', 'verifyReport must return an object synchronously, not a Promise')
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('parseDiagrams: extracts unified DiagramModel with nodes, footprints, and technology marks', () => {
  const html = diagram(node('a', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', logo: logo({ slug: 'react' }) }))
  const diagrams = parseDiagrams(html)
  assert.equal(diagrams.length, 1)
  const diag = diagrams[0]
  assert.equal(diag.nodes.length, 1)
  const n = diag.nodes[0]
  assert.equal(n.width, 132)
  assert.equal(n.height, 100)
  assert.equal(n.tile.width, 60)
  assert.equal(n.tile.height, 60)
  assert.ok(n.logo)
  assert.equal(n.logo.slug, 'react')
  assert.equal(n.kindCode, false)
})

test('verifyReport: verifies technology marks using default contract marks without options', () => {
  const html = diagram(node('a', { cx: 120, tileY: 90, title: 'Handler', subtitle: 'handler', logo: logo({ slug: 'unknown-tech-slug' }) }))
  const errors = verifyReport(validBundle({ 'architecture.html': html })).errors
  assert.ok(errors.some(e => e.includes('"unknown-tech-slug" is not a mark in docs/technology-marks.json')))
})
