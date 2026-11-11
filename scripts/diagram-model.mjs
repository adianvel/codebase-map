/**
 * Diagram Model extraction.
 *
 * One interface: parseDiagrams(html, footprint). Everything the Report
 * Verifier needs to know about a drawn diagram — viewBox, nodes with
 * footprints and technology marks, segmented edges, and labels — is
 * extracted here, so the geometry and mark checks consume the model
 * and never the raw markup. The footprint dimensions come from the
 * supplied geometry (docs/diagram-geometry.json); without them a node
 * falls back to its tile box.
 *
 * Zero dependencies, so it runs anywhere Node runs.
 */

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

function transformOf(el) {
  const raw = attribute(el, 'transform')
  if (!raw) return null
  const move = raw.match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/)
  const zoom = raw.match(/scale\(\s*(-?[\d.]+)\s*\)/)
  if (!move || !zoom) return null
  return { x: parseFloat(move[1]), y: parseFloat(move[2]), scale: parseFloat(zoom[1]) }
}

const COLOUR_ATTRIBUTE = /\b(?:fill|stroke|color|style)\s*=/i

function decodedText(raw) {
  return raw.replace(/&(?:[a-z]+|#\d+|#[xX][0-9a-fA-F]+);/g, 'x')
}

// Read the size from the report's own CSS. A label whose size the report does
// not state is a label the budget cannot be decided for, so it is skipped.
function fontSizeFor(html, className) {
  const rule = html.match(new RegExp(`\\.${className}\\s*\\{[^}]*font-size\\s*:\\s*([\\d.]+)px`))
  return rule ? parseFloat(rule[1]) : null
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

function parseDiagram(svg, html, footprint = {}) {
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
    const width = footprint.footprintWidth ?? tile.width
    const height = footprint.footprintHeight ?? tile.height
    const box = {
      x: centre - width / 2,
      y: tile.y,
      width,
      height,
      tile,
    }
    box.labels = []
    for (const match of block.matchAll(/<text\b[^>]*class="[^"]*\bnode-(title|subtitle)\b[^"]*"[^>]*>([^<]*)<\/text>/g)) {
      const kind = `node-${match[1]}`
      const fontSize = fontSizeFor(html, kind)
      if (fontSize === null) continue
      box.labels.push({ kind: match[1], chars: decodedText(match[2]).length, fontSize })
    }

    const logoMatch = block.match(/<g\b[^>]*class="[^"]*\btile-logo\b[^"]*"[\s\S]*?<\/g>/)
    const kindCode = /class="[^"]*\btile-mark\b/.test(block)
    let logo = null
    if (logoMatch) {
      const groupMatch = logoMatch[0].match(/^<g\b[^>]*>/)
      const group = groupMatch ? groupMatch[0] : ''
      const pathMatch = logoMatch[0].match(/<path\b[^>]*\bd\s*=\s*"([^"]*)"/)
      logo = {
        raw: logoMatch[0],
        group,
        slug: attribute(group, 'data-tech'),
        hasColour: COLOUR_ATTRIBUTE.test(logoMatch[0]),
        path: pathMatch ? pathMatch[1] : null,
        placed: transformOf(group),
      }
    }
    box.logo = logo
    box.kindCode = kindCode

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

  return { viewBox, name: title ? title[1].trim() : 'diagram', nodes, edges, labels, raw: svg }
}

export function parseDiagrams(html, footprint = {}) {
  const diagrams = html.match(/<svg\b(?![^>]*class="[^"]*icon)[^>]*>[\s\S]*?<\/svg>/g) || []
  return diagrams.map(svg => parseDiagram(svg, html, footprint))
}
