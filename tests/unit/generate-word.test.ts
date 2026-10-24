import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { generateWordBuffer } from '../../domains/word-generation/generate-word.js'
import {
  listWordProfiles,
  loadWordProfile,
} from '../../domains/word-generation/word-profiles.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('Generate Word exposes reusable data-driven profiles', () => {
  assert.deepEqual(
    listWordProfiles().map(({ id }) => id),
    [
      'business-report',
      'executive-summary',
      'research-report',
      'proposal',
      'instruction-manual',
    ],
  )
})

test('Generate Word accepts a fully data-driven custom profile file', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-word-profile-'))
  try {
    const profileFile = JSON.parse(fs.readFileSync(
      path.join(
        process.cwd(),
        'domains',
        'word-generation',
        'profiles.json',
      ),
      'utf8',
    ))
    profileFile.profiles['business-report'].displayName = 'Custom Report'
    profileFile.profiles['business-report'].layout.titleAfter = 777
    profileFile.profiles['business-report'].mermaid.paddingPx = 0
    const profilePath = path.join(workspace, 'profiles.json')
    fs.writeFileSync(profilePath, JSON.stringify(profileFile))

    const profile = loadWordProfile('business-report', profilePath)

    assert.equal(profile.displayName, 'Custom Report')
    assert.equal(profile.layout.titleAfter, 777)
    assert.equal(profile.mermaid.paddingPx, 0)
    assert.ok(Object.isFrozen(profile.layout))
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('Generate Word emits native TOC fields and embeds local images', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-word-image-'))
  try {
    fs.writeFileSync(path.join(workspace, 'chart.png'), ONE_PIXEL_PNG)
    const generated = await generateWordBuffer(`# Business Review

## Summary

The report includes a local chart.

![Quarterly chart](chart.png)

### Detail

| Measure | Result |
| --- | ---: |
| Conversion | 42% |

- [x] Generated
- [ ] Reviewed
`, {
      profile: 'business-report',
      sourceDirectory: workspace,
    })
    const docxPath = path.join(workspace, 'report.docx')
    fs.writeFileSync(docxPath, generated.buffer)

    assert.equal(generated.profile.id, 'business-report')
    assert.deepEqual(generated.warnings, [])
    const entries = unzip(docxPath, '-Z1')
    assert.match(entries, /^word\/media\/.+\.png$/m)
    const documentXml = unzip(docxPath, '-p', 'word/document.xml')
    assert.match(documentXml, /TOC \\h \\o &quot;1-3&quot;/)
    assert.match(documentXml, /w:pStyle w:val="TOC2"/)
    assert.match(documentXml, /Heading2/)
    assert.match(documentXml, /Quarterly chart/)
    assert.match(documentXml, /☒ <\/w:t>.*Generated/s)
    assert.match(documentXml, /☐ <\/w:t>.*Reviewed/s)
    const settingsXml = unzip(docxPath, '-p', 'word/settings.xml')
    assert.match(settingsXml, /<w:updateFields(?: w:val="true")?\/>/)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('Generate Word renders a real Mermaid diagram to embedded PNG', {
  timeout: 30_000,
}, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-word-mermaid-'))
  try {
    const generated = await generateWordBuffer(`# Architecture

## Flow

\`\`\`mermaid
flowchart LR
  A[Markdown] --> B[Generate Word]
  B --> C[DOCX]
\`\`\`
`, {
      profile: 'research-report',
      sourceDirectory: workspace,
    }).catch((error) => {
      if (
        error instanceof Error &&
        /Chrome or Chromium is required/.test(error.message)
      ) {
        t.skip(error.message)
        return null
      }
      throw error
    })
    if (!generated) return
    const docxPath = path.join(workspace, 'mermaid.docx')
    fs.writeFileSync(docxPath, generated.buffer)
    const mediaEntries = unzip(docxPath, '-Z1')
      .split('\n')
      .filter((entry) => /^word\/media\/.+\.png$/.test(entry))
    assert.equal(mediaEntries.length, 1)
    const image = spawnSync('unzip', ['-p', docxPath, mediaEntries[0]!])
    assert.equal(image.status, 0)
    assert.equal(image.stdout.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.ok(image.stdout.byteLength > 1_000)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

function unzip(filePath: string, ...args: string[]): string {
  const commandArgs = args[0] === '-p'
    ? ['-p', filePath, ...args.slice(1)]
    : [...args, filePath]
  const result = spawnSync('unzip', commandArgs, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
