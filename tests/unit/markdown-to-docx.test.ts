import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import { markdownToDocxBuffer } from '../../workflows/markdown-to-docx.js'

test('markdownToDocxBuffer creates a real Word package from report structures', async () => {
  const buffer = await markdownToDocxBuffer(`---
artifact_type: report
schema_version: 1
---
# Evidence Report

## Findings

The primary finding is **supported** by [the source](https://example.com/source).

- First point
- Second point

| Metric | Value |
| --- | ---: |
| Coverage | 100% |

> A bounded caveat.

\`\`\`text
observed evidence
\`\`\`
`)

  assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK')
  assert.ok(buffer.byteLength > 5_000)
  assert.equal(buffer.includes(Buffer.from('artifact_type: report')), false)
})

test('markdownToDocxBuffer only creates external relationships for safe URL schemes', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-docx-links-'))
  try {
    const buffer = await markdownToDocxBuffer(`# Link policy

[Web source](https://example.com/source?q=research)
[Email](mailto:research@example.com)
[Local file](file:///etc/passwd)
[UNC file](file://server/share/report.docx)
[Custom app](vscode://file/etc/passwd)
[Malformed](not-a-valid-url)
![Local image](file:///tmp/chart.png)
`)
    const docxPath = path.join(workspace, 'links.docx')
    fs.writeFileSync(docxPath, buffer)

    const relationships = spawnSync(
      'unzip',
      ['-p', docxPath, 'word/_rels/document.xml.rels'],
      { encoding: 'utf8' },
    )
    assert.equal(relationships.status, 0, relationships.stderr)
    const externalTargets = [...relationships.stdout.matchAll(
      /Target="([^"]+)" TargetMode="External"/g,
    )].map((match) => match[1])
    assert.deepEqual(externalTargets.sort(), [
      'https://example.com/source?q=research',
      'mailto:research@example.com',
    ])

    const documentXml = spawnSync(
      'unzip',
      ['-p', docxPath, 'word/document.xml'],
      { encoding: 'utf8' },
    )
    assert.equal(documentXml.status, 0, documentXml.stderr)
    assert.match(documentXml.stdout, /Local file/)
    assert.match(documentXml.stdout, /Custom app/)
    assert.match(documentXml.stdout, /\[Image: Local image\]/)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('markdownToDocxBuffer creates a valid large report within the release budget', {
  timeout: 30_000,
}, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-docx-large-'))
  const sections = Array.from({ length: 400 }, (_, index) => {
    const section = index + 1
    return `## Section ${section}: Evidence synthesis

Finding ${section} combines independently observed evidence, a quantified result of ${section * 7}, and a bounded interpretation for decision makers. The supporting record is [source ${section}](https://example.com/evidence/${section}).

- Verified observation ${section}.1 with source attribution
- Verified observation ${section}.2 with a stated limitation
- Competing explanation ${section}.3 retained for review
- Follow-up question ${section}.4 assigned to the next research wave

| Measure | Observed value | Confidence |
| --- | ---: | --- |
| Coverage | ${80 + (section % 20)}% | High |
| Independent sources | ${2 + (section % 4)} | Medium |

> Limitation ${section}: the result should not be generalized beyond the approved scope.
`
  }).join('\n')
  const markdown = `# Large Deep Research Report

This release fixture exercises a realistically long, source-rich report.

${sections}
`
  assert.ok(Buffer.byteLength(markdown) > 250_000)

  try {
    const startedAt = performance.now()
    const buffer = await markdownToDocxBuffer(markdown)
    const elapsedMs = performance.now() - startedAt
    const docxPath = path.join(workspace, 'large-report.docx')
    fs.writeFileSync(docxPath, buffer)

    assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK')
    assert.ok(buffer.byteLength > 50_000)
    assert.ok(elapsedMs < 12_000, `large DOCX conversion took ${elapsedMs.toFixed(0)}ms`)

    const integrity = spawnSync('unzip', ['-t', docxPath], { encoding: 'utf8' })
    assert.equal(integrity.status, 0, integrity.stderr || integrity.stdout)
    assert.match(integrity.stdout, /No errors detected/)

    const entries = spawnSync('unzip', ['-Z1', docxPath], { encoding: 'utf8' })
    assert.equal(entries.status, 0, entries.stderr)
    assert.match(entries.stdout, /^\[Content_Types\]\.xml$/m)
    assert.match(entries.stdout, /^word\/document\.xml$/m)

    const documentXml = spawnSync(
      'unzip',
      ['-p', docxPath, 'word/document.xml'],
      { encoding: 'utf8', maxBuffer: 20 * 1_024 * 1_024 },
    )
    assert.equal(documentXml.status, 0, documentXml.stderr)
    assert.match(documentXml.stdout, /Large Deep Research Report/)
    assert.match(documentXml.stdout, /Section 400: Evidence synthesis/)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
