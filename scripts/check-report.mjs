#!/usr/bin/env node
/**
 * FileSystem Adapter for the report check.
 *
 *   node scripts/check-report.mjs <report-dir>
 *
 * Reads a report directory from disk into a Report Bundle, loads every
 * Report Contract asset (template, technology marks, diagram
 * geometry), and passes the resolved values to the Report Verifier
 * (scripts/report-verifier.mjs). Formats the result for the terminal.
 * All filesystem access for the report check lives in this module.
 */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyReport, REQUIRED_FILES } from './report-verifier.mjs'

// The report template is the single home for the palette. Compare against it so
// a colour changed in one place cannot silently diverge from the others.
const TEMPLATE_PATH = new URL('../docs/report-template.html', import.meta.url)

// The only marks a report may draw. A path outside this file is a mark somebody
// drew from memory, which is the failure mode this asset exists to prevent.
const MARKS_PATH = new URL('../docs/technology-marks.json', import.meta.url)
const GEOMETRY_PATH = new URL('../docs/diagram-geometry.json', import.meta.url)
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

  const bundle = {}
  for (const name of REQUIRED_FILES) {
    try {
      bundle[name] = await readFile(join(dir, name), 'utf8')
    } catch {
      bundle[name] = undefined
    }
  }

  const loadText = async (supplied, path) => {
    if (supplied !== undefined) return supplied
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  }
  const loadJson = async (supplied, path) => {
    if (supplied !== undefined) return supplied
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return null
    }
  }
  const templateHtml = await loadText(options.templateHtml, options.templatePath || TEMPLATE_PATH)
  const marks = await loadJson(options.marks, options.marksPath || MARKS_PATH)
  const geometry = await loadJson(options.geometry, options.geometryPath || GEOMETRY_PATH)

  const result = verifyReport(bundle, { templateHtml, marks, geometry })

  return {
    ok: result.ok,
    dir,
    errors: result.errors,
  }
}
async function cli(args = process.argv.slice(2)) {
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
