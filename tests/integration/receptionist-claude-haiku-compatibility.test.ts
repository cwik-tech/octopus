/**
 * Claude Code can auto-load repository instructions in addition to the
 * application's own prompt. The paid subscription boundary is replaced here;
 * the Receptionist, full shipped prompt, schema, and Claude adapter stay real.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { runReceptionistTurn } from '../../domains/sessions/chat-llm.js'
import { createRunPlan } from '../../domains/run-orchestrator/orchestrator.js'
import { createClaudeProvider } from '../../providers/claude.js'
import { registerProvider } from '../../providers/registry.js'
import { listWorkflowEntries } from '../../services/workflow-service.js'

test('a Claude Haiku Receptionist turn keeps the full application contract isolated from ambient repository instructions', async () => {
  const binDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'receptionist-claude-haiku-'),
  )
  const executablePath = path.join(binDirectory, 'claude')
  const originalPath = process.env.PATH
  const workflows = listWorkflowEntries(
    path.join(process.cwd(), 'workflows', 'registry.yaml'),
  )
  assert.ok(workflows.length > 0, 'the shipped workflow catalog is required')
  const plan = createRunPlan({
    goal: 'Please reply with a short greeting.',
    workflows,
  })
  const expectedWorkflowIds = workflows.map((workflow) => workflow.id)

  fs.writeFileSync(
    executablePath,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const promptFileIndex = args.indexOf('--system-prompt-file')
const promptFile = promptFileIndex < 0 ? null : args[promptFileIndex + 1]
const systemPrompt = promptFile === null ? '' : fs.readFileSync(promptFile, 'utf8')
const promptMode = promptFile === null ? null : fs.statSync(promptFile).mode & 0o777
const settingsSourcesIndex = args.indexOf('--setting-sources')
const expectedWorkflowIds = ${JSON.stringify(expectedWorkflowIds)}
const inputChunks = []
process.stdin.on('data', chunk => inputChunks.push(chunk))
process.stdin.on('end', () => {
  const input = Buffer.concat(inputChunks).toString('utf8')
  const unsupported =
    args.includes('--system-prompt') ||
    promptMode !== 0o600 ||
    settingsSourcesIndex < 0 ||
    args[settingsSourcesIndex + 1] !== '' ||
    !args.includes('--json-schema') ||
    !expectedWorkflowIds.every(id => systemPrompt.includes(id)) ||
    !systemPrompt.includes('needs_input') ||
    !systemPrompt.includes('deepResearchPlanAction') ||
    !input.includes('Please reply with a short greeting.')
  process.stdout.write(JSON.stringify(unsupported
    ? {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Prompt is too long or application contract is missing',
      }
    : {
        type: 'result',
        subtype: 'success',
        is_error: false,
        structured_output: {
          message: 'Hello from the Receptionist.',
          selectionAction: 'clear',
          workflowId: null,
          launchIntent: 'none',
          deepResearchPlanAction: 'keep',
          deepResearchMissingInputs: [],
        },
      }) + '\\n')
})
`,
    { mode: 0o755 },
  )

  registerProvider(
    createClaudeProvider(),
    {
      source: 'tests/integration/receptionist-claude-haiku-compatibility.test.ts',
      trustClass: 'test',
    },
    { replaceExisting: true },
  )
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ''}`

  try {
    const result = await runReceptionistTurn({
      history: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Please reply with a short greeting.',
          createdAt: '2026-08-27T00:00:00.000Z',
        },
      ],
      workflows,
      plan,
      provider: 'claude',
      model: 'haiku',
    })

    assert.equal(result.fallback, false, result.reason)
    assert.equal(result.text, 'Hello from the Receptionist.')
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(binDirectory, { recursive: true, force: true })
  }
})
