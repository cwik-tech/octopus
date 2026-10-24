#!/usr/bin/env node

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { whenDefined } from '../core/optional-properties.js'

import { generateWordBuffer } from '../domains/word-generation/generate-word.js'
import { listWordProfiles } from '../domains/word-generation/word-profiles.js'

export async function runGenerateWordCli(
  argv = process.argv.slice(2),
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      profile: { type: 'string', short: 'p', default: 'business-report' },
      'profile-file': { type: 'string' },
      toc: { type: 'boolean' },
      'no-toc': { type: 'boolean' },
      mermaid: { type: 'boolean' },
      'no-mermaid': { type: 'boolean' },
      'keep-mermaid-code': { type: 'boolean' },
      'list-profiles': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.values.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (parsed.values['list-profiles']) {
    for (const profile of listWordProfiles()) {
      process.stdout.write(
        `${profile.id}\t${profile.displayName}\t${profile.description}\n`,
      )
    }
    return 0
  }
  const input = parsed.values.input ?? parsed.positionals[0]
  const output = parsed.values.output ?? parsed.positionals[1]
  if (!input || !output) {
    process.stderr.write(`Both input and output paths are required.\n\n${usage()}\n`)
    return 2
  }
  if (path.extname(input).toLowerCase() !== '.md') {
    process.stderr.write('Generate Word input must be a Markdown (.md) file.\n')
    return 2
  }
  if (path.extname(output).toLowerCase() !== '.docx') {
    process.stderr.write('Generate Word output must be a Word (.docx) file.\n')
    return 2
  }
  if (parsed.values.toc && parsed.values['no-toc']) {
    process.stderr.write('Use either --toc or --no-toc, not both.\n')
    return 2
  }
  if (parsed.values.mermaid && parsed.values['no-mermaid']) {
    process.stderr.write('Use either --mermaid or --no-mermaid, not both.\n')
    return 2
  }
  const inputPath = path.resolve(input)
  const outputPath = path.resolve(output)
  const markdown = await fs.readFile(inputPath, 'utf8')
  const generated = await generateWordBuffer(markdown, {
    profile: parsed.values.profile,
    ...whenDefined(parsed.values['profile-file'], (profilePath) => ({ profilePath })),
    sourceDirectory: path.dirname(inputPath),
    ...whenDefined(parsed.values.toc
      ? true
      : parsed.values['no-toc']
        ? false
        : undefined, (tableOfContents) => ({ tableOfContents })),
    ...whenDefined(parsed.values.mermaid
      ? true
      : parsed.values['no-mermaid']
        ? false
        : undefined, (renderMermaid) => ({ renderMermaid })),
    mermaidFailure: parsed.values['keep-mermaid-code']
      ? 'keep-code'
      : 'error',
  })
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporaryPath, generated.buffer)
    await fs.rename(temporaryPath, outputPath)
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
  process.stdout.write(
    `Generated ${outputPath} with profile '${generated.profile.id}' (${generated.buffer.byteLength} bytes).\n`,
  )
  for (const warning of generated.warnings) {
    process.stderr.write(`Warning: ${warning}\n`)
  }
  return 0
}

function usage(): string {
  return [
    'Usage: npm run generate:word -- <input.md> <output.docx> [options]',
    '',
    'Options:',
    '  -p, --profile <id>       Formatting profile (default: business-report)',
    '      --profile-file <json> Load profiles from a schema-version-1 JSON file',
    '      --toc / --no-toc     Override the profile table-of-contents setting',
    '      --mermaid / --no-mermaid',
    '                            Override local Mermaid-to-PNG rendering',
    '      --keep-mermaid-code  Keep invalid diagrams as code with a warning',
    '      --list-profiles      List the built-in profiles',
    '  -h, --help               Show this help',
  ].join('\n')
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runGenerateWordCli()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(
        `Generate Word failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
      process.exitCode = 1
    })
}
