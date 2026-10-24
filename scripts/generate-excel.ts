#!/usr/bin/env node

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { whenDefined } from '../core/optional-properties.js'

import { generateExcelBuffer } from '../domains/excel-generation/generate-excel.js'
import { listExcelProfiles } from '../domains/excel-generation/excel-profiles.js'
import {
  excelTemplateSummary,
  fillExcelTemplate,
  listExcelTemplates,
  loadExcelTemplate,
  parseExcelTemplateData,
  resolveDefaultExcelTemplatesRoot,
} from '../domains/excel-generation/excel-templates.js'

export async function runGenerateExcelCli(
  argv = process.argv.slice(2),
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      profile: { type: 'string', short: 'p', default: 'business-workbook' },
      'profile-file': { type: 'string' },
      template: { type: 'string', short: 't' },
      'templates-dir': { type: 'string' },
      'list-profiles': { type: 'boolean' },
      'list-templates': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const templatesRoot = parsed.values['templates-dir']
    ? path.resolve(parsed.values['templates-dir'])
    : resolveDefaultExcelTemplatesRoot()
  if (parsed.values.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (parsed.values['list-profiles']) {
    for (const profile of listExcelProfiles()) {
      process.stdout.write(
        `${profile.id}\t${profile.displayName}\t${profile.description}\n`,
      )
    }
    return 0
  }
  if (parsed.values['list-templates']) {
    const listed = listExcelTemplates(templatesRoot)
    for (const template of listed.templates) {
      const summary = excelTemplateSummary(template)
      process.stdout.write(
        `${summary.id}\t${summary.displayName}\t${summary.description}\n`,
      )
    }
    for (const warning of listed.warnings) {
      process.stderr.write(`Warning: ${warning}\n`)
    }
    return 0
  }
  const input = parsed.values.input ?? parsed.positionals[0]
  const output = parsed.values.output ?? parsed.positionals[1]
  if (!input || !output) {
    process.stderr.write(`Both input and output paths are required.\n\n${usage()}\n`)
    return 2
  }
  const template = parsed.values.template
  const expectedInputExtension = template ? '.json' : '.md'
  if (path.extname(input).toLowerCase() !== expectedInputExtension) {
    process.stderr.write(
      template
        ? 'Generate Excel template data must be a JSON (.json) file.\n'
        : 'Generate Excel input must be a Markdown (.md) file.\n',
    )
    return 2
  }
  if (path.extname(output).toLowerCase() !== '.xlsx') {
    process.stderr.write('Generate Excel output must be an Excel (.xlsx) file.\n')
    return 2
  }
  const inputPath = path.resolve(input)
  const outputPath = path.resolve(output)
  const source = await fs.readFile(inputPath, 'utf8')
  let buffer: Buffer
  let warnings: readonly string[]
  let summary: string
  if (template) {
    const loaded = loadExcelTemplate(templatesRoot, template)
    const filled = await fillExcelTemplate(
      loaded,
      parseExcelTemplateData(JSON.parse(source)),
    )
    buffer = filled.buffer
    warnings = filled.warnings
    summary = `template '${loaded.manifest.id}'`
  } else {
    const generated = await generateExcelBuffer(source, {
      profile: parsed.values.profile,
      ...whenDefined(parsed.values['profile-file'], (profilePath) => ({ profilePath })),
    })
    buffer = generated.buffer
    warnings = generated.warnings
    summary = `profile '${generated.profile.id}'`
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporaryPath, buffer)
    await fs.rename(temporaryPath, outputPath)
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
  process.stdout.write(
    `Generated ${outputPath} with ${summary} (${buffer.byteLength} bytes).\n`,
  )
  for (const warning of warnings) {
    process.stderr.write(`Warning: ${warning}\n`)
  }
  return 0
}

function usage(): string {
  return [
    'Usage: npm run generate:excel -- <input.md> <output.xlsx> [options]',
    '       npm run generate:excel -- <data.json> <output.xlsx> --template <id>',
    '',
    'Options:',
    '  -p, --profile <id>       Formatting profile (default: business-workbook)',
    '      --profile-file <json> Load profiles from a schema-version-1 JSON file',
    '  -t, --template <id>      Fill a domains/excel-generation/templates/<id> workbook with JSON data',
    '      --templates-dir <dir> Templates directory (default: domains/excel-generation/templates)',
    '      --list-profiles      List the built-in profiles',
    '      --list-templates     List the available workbook templates',
    '  -h, --help               Show this help',
  ].join('\n')
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runGenerateExcelCli()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(
        `Generate Excel failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
      process.exitCode = 1
    })
}
