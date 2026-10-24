import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'

import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { GenerateWordToolService } from '../../services/generate-word-tool-service.js'

test('Generate Word tool is persona-gated and writes only assignment artifacts', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'generate-word-tool-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const agentDirectory = path.join(repoRootPath, 'agents', 'writer')
  const identity = {
    sessionId: 'session-word',
    runId: 'run-word',
    assignmentId: 'assignment-word',
  }
  const context = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-word',
    leaseId: 'lease-word',
    ...identity,
    agentPath: 'agents/writer',
  }
  try {
    fs.mkdirSync(agentDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(agentDirectory, 'writer.md'),
      '---\nname: writer\ntools: generate_word\n---\n\n# Writer\n',
    )
    const location = buildSessionRunAssignmentLocation(workspacePath, identity)
    assert.ok(location)
    fs.mkdirSync(location.assignmentPath, { recursive: true })
    fs.writeFileSync(
      path.join(location.assignmentPath, 'report.md'),
      '# Generated report\n\n## Finding\n\nThe result is complete.\n',
    )
    const service = new GenerateWordToolService({
      workspacePath,
      repoRootPath,
    })

    const profiles = await service.execute(
      context,
      'call-profiles',
      { action: 'list_profiles' },
    )
    assert.equal(profiles.ok, true)
    assert.equal(profiles.profiles?.length, 5)

    const generated = await service.execute(
      context,
      'call-generate',
      {
        action: 'generate',
        inputPath: 'report.md',
        outputPath: 'exports/report.docx',
        profile: 'proposal',
        renderMermaid: false,
      },
    )
    assert.equal(generated.ok, true)
    assert.equal(generated.outputPath, 'exports/report.docx')
    assert.equal(generated.profile, 'proposal')
    assert.equal('digest' in generated ? generated.digest : undefined, createHash('sha256').update(fs.readFileSync(path.join(location.assignmentPath, 'exports/report.docx'))).digest('hex'))
    assert.equal(
      fs.readFileSync(
        path.join(location.assignmentPath, 'exports', 'report.docx'),
      ).subarray(0, 2).toString('ascii'),
      'PK',
    )

    const inlineGenerated = await service.execute(
      context,
      'call-generate-inline',
      {
        action: 'generate',
        markdown: '# Inline report\n\nThe agent supplied this source directly.\n',
        outputPath: 'exports/inline-report.docx',
        profile: 'research-report',
      },
    )
    assert.equal(inlineGenerated.ok, true)
    assert.equal(inlineGenerated.outputPath, 'exports/inline-report.docx')
    assert.equal(inlineGenerated.sourcePath, 'exports/inline-report.md')
    assert.equal(
      fs.readFileSync(
        path.join(location.assignmentPath, 'exports', 'inline-report.md'),
        'utf8',
      ),
      '# Inline report\n\nThe agent supplied this source directly.\n',
    )
    assert.equal(
      fs.readFileSync(
        path.join(location.assignmentPath, 'exports', 'inline-report.docx'),
      ).subarray(0, 2).toString('ascii'),
      'PK',
    )

    const conflictingSource = await service.execute(
      context,
      'call-conflicting-source',
      {
        action: 'generate',
        inputPath: 'report.md',
        markdown: '# Conflicting source',
        outputPath: 'exports/conflicting.docx',
      },
    )
    assert.equal(conflictingSource.ok, false)
    assert.equal(conflictingSource.error?.code, 'invalid_request')

    const escaped = await service.execute(
      context,
      'call-escape',
      {
        action: 'generate',
        inputPath: 'report.md',
        outputPath: '../outside.docx',
      },
    )
    assert.equal(escaped.ok, false)
    assert.equal(escaped.error?.code, 'invalid_request')

    fs.writeFileSync(
      path.join(agentDirectory, 'writer.md'),
      '---\nname: writer\ntools: none\n---\n\n# Writer\n',
    )
    const denied = await service.execute(
      context,
      'call-denied',
      { action: 'list_profiles' },
    )
    assert.equal(denied.ok, false)
    assert.equal(denied.error?.code, 'not_enabled')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
