import assert from 'node:assert/strict'
import test from 'node:test'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityDispatchEvent,
} from '../../contracts/capability-dispatch.js'
import type { McpNamespacedTool } from '../../domains/mcp/mcp-runtime.js'
import type { GenerateExcelToolOutput } from '../../domains/excel-generation/generate-excel-types.js'
import type { GenerateWordToolOutput } from '../../domains/word-generation/generate-word-types.js'
import {
  GENERATE_EXCEL_BUILTIN_SOURCE,
  GenerateExcelCapabilityDispatchGateway,
  type GenerateExcelCapabilityService,
} from '../../services/generate-excel-capability-adapter.js'
import {
  GENERATE_WORD_BUILTIN_SOURCE,
  GenerateWordCapabilityDispatchGateway,
  type GenerateWordCapabilityService,
} from '../../services/generate-word-capability-adapter.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

test('document list actions are read-only while generation and fill actions are mutating', async () => {
  const events: CapabilityDispatchEvent[] = []
  const word = wordGateway(
    events,
    async (_context, _toolCallId, input) => wordSuccess(input.action),
  )
  const excel = excelGateway(
    events,
    async (_context, _toolCallId, input) => excelSuccess(input.action),
  )

  await word.execute(wordInvocation('word-list', { action: 'list_profiles' }))
  await word.execute(wordInvocation('word-generate', {
    action: 'generate',
    inputPath: 'input.md',
    outputPath: 'output.docx',
  }))
  await excel.execute(excelInvocation('excel-profiles', { action: 'list_profiles' }))
  await excel.execute(excelInvocation('excel-templates', { action: 'list_templates' }))
  await excel.execute(excelInvocation('excel-generate', {
    action: 'generate',
    inputPath: 'input.md',
    outputPath: 'output.xlsx',
  }))
  await excel.execute(excelInvocation('excel-fill', {
    action: 'fill_template',
    inputPath: 'input.json',
    outputPath: 'output.xlsx',
    template: 'risk-register',
  }))

  assert.deepEqual(
    events
      .filter((event) => event.type === 'capability.dispatch.requested')
      .map((event) => [event.requestId, event.effect]),
    [
      ['request-word-list', serialCapabilityEffect('read-only')],
      ['request-word-generate', serialCapabilityEffect('mutating')],
      ['request-excel-profiles', serialCapabilityEffect('read-only')],
      ['request-excel-templates', serialCapabilityEffect('read-only')],
      ['request-excel-generate', serialCapabilityEffect('mutating')],
      ['request-excel-fill', serialCapabilityEffect('mutating')],
    ],
  )
})

test('typed document failures are projected to callers without entering dispatch evidence', async () => {
  const secret = 'private/input-path.md'
  const wordFailureMessage = `Generate Word could not read ${secret}.`
  const excelFailureMessage = `Generate Excel rejected ${secret}.`
  const events: CapabilityDispatchEvent[] = []
  const wordFailure: GenerateWordToolOutput = {
    ok: false,
    action: 'generate',
    error: {
      code: 'not_found',
      message: wordFailureMessage,
      retryable: false,
    },
  }
  const excelFailure: GenerateExcelToolOutput = {
    ok: false,
    action: 'fill_template',
    error: {
      code: 'invalid_request',
      message: excelFailureMessage,
      retryable: false,
    },
  }
  const word = wordGateway(events, async () => wordFailure)
  const excel = excelGateway(events, async () => excelFailure)

  assert.deepEqual(
    await word.execute(wordInvocation('word-failure', {
      action: 'generate',
      inputPath: secret,
      outputPath: 'output.docx',
    })),
    wordFailure,
  )
  assert.deepEqual(
    await excel.execute(excelInvocation('excel-failure', {
      action: 'fill_template',
      inputPath: 'input.json',
      outputPath: 'output.xlsx',
      template: 'risk-register',
    })),
    excelFailure,
  )
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith('capability.dispatch.indeterminate'))
      .map((event) => event.code),
    ['capability_execution_indeterminate', 'capability_execution_indeterminate'],
  )
  assert.equal(JSON.stringify(events).includes(secret), false)
  assert.equal(JSON.stringify(events).includes(wordFailureMessage), false)
  assert.equal(JSON.stringify(events).includes(excelFailureMessage), false)
})

test('document capability permission is rechecked before execution', async () => {
  let executions = 0
  const wordService = makeWordService(async () => {
    executions += 1
    return wordSuccess('list_profiles')
  }, false)
  const excelService = makeExcelService(async () => {
    executions += 1
    return excelSuccess('list_profiles')
  }, false)
  const word = new GenerateWordCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(),
    service: wordService,
  })
  const excel = new GenerateExcelCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(),
    service: excelService,
  })

  assert.deepEqual(
    await word.execute(wordInvocation('word-disabled', { action: 'list_profiles' })),
    {
      ok: false,
      action: 'list_profiles',
      error: {
        code: 'not_enabled',
        message: 'This agent is not allowed to use Generate Word.',
        retryable: false,
      },
    },
  )
  assert.deepEqual(
    await excel.execute(excelInvocation('excel-disabled', { action: 'list_profiles' })),
    {
      ok: false,
      action: 'list_profiles',
      error: {
        code: 'not_enabled',
        message: 'This agent is not allowed to use Generate Excel.',
        retryable: false,
      },
    },
  )
  assert.equal(executions, 0)
})

test('document capability rejects malformed input and invalid executor output', async () => {
  let executions = 0
  const word = wordGateway([], async () => {
    executions += 1
    return { ok: true, action: 'generate' }
  })
  const excel = excelGateway([], async () => {
    executions += 1
    return { ok: true, action: 'fill_template' }
  })

  const malformed = await word.execute(wordInvocation('word-malformed', {
    action: 'generate',
    inputPath: 'input.md',
  }))
  assert.deepEqual(malformed, {
    ok: false,
    action: 'generate',
    error: {
      code: 'invalid_request',
      message: 'Generate Word request is invalid.',
      retryable: false,
    },
  })
  assert.equal(executions, 0)

  const invalidExecutorOutput = await excel.execute(excelInvocation(
    'excel-invalid-output',
    {
      action: 'fill_template',
      inputPath: 'input.json',
      outputPath: 'output.xlsx',
      template: 'risk-register',
    },
  ))
  assert.deepEqual(invalidExecutorOutput, {
    ok: false,
    action: 'fill_template',
    error: {
      code: 'internal',
      message: 'Generate Excel capability returned an invalid result.',
      retryable: true,
    },
  })
  assert.equal(executions, 1)
})

function wordGateway(
  events: CapabilityDispatchEvent[],
  execute: GenerateWordCapabilityService['execute'],
): GenerateWordCapabilityDispatchGateway {
  return new GenerateWordCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(events),
    service: makeWordService(execute),
  })
}

function excelGateway(
  events: CapabilityDispatchEvent[],
  execute: GenerateExcelCapabilityService['execute'],
): GenerateExcelCapabilityDispatchGateway {
  return new GenerateExcelCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(events),
    service: makeExcelService(execute),
  })
}

function makeWordService(
  execute: GenerateWordCapabilityService['execute'],
  enabled = true,
): GenerateWordCapabilityService {
  return {
    tool: documentTool('generate_word', 'builtin.generate-word'),
    isEnabledForAgent: () => enabled,
    execute,
  }
}

function makeExcelService(
  execute: GenerateExcelCapabilityService['execute'],
  enabled = true,
): GenerateExcelCapabilityService {
  return {
    tool: documentTool('generate_excel', 'builtin.generate-excel'),
    isEnabledForAgent: () => enabled,
    execute,
  }
}

function documentTool(name: string, serverId: string): McpNamespacedTool {
  return {
    serverId,
    serverName: name,
    toolName: name,
    namespacedName: name,
    description: name,
    inputSchema: { type: 'object' },
    annotations: { openWorldHint: false },
    risk: 'mutating',
    effect: serialCapabilityEffect('mutating'),
    requiresApproval: false,
  }
}

function wordInvocation(
  id: string,
  input: Readonly<Record<string, string>>,
) {
  return {
    context: capabilityContext(id),
    authority: { kind: 'mcp-lease' as const, leaseId: 'lease-1' },
    source: GENERATE_WORD_BUILTIN_SOURCE,
    toolCallId: id,
    input,
  }
}

function excelInvocation(
  id: string,
  input: Readonly<Record<string, string>>,
) {
  return {
    context: capabilityContext(id),
    authority: { kind: 'mcp-lease' as const, leaseId: 'lease-1' },
    source: GENERATE_EXCEL_BUILTIN_SOURCE,
    toolCallId: id,
    input,
  }
}

function capabilityContext(id: string) {
  return {
    contractVersion: 1 as const,
    requestId: `request-${id}`,
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/documenter',
  }
}

function wordSuccess(action: unknown): GenerateWordToolOutput {
  if (action === 'list_profiles') {
    return { ok: true, action, profiles: [] }
  }
  return {
    ok: true,
    action: 'generate',
    outputPath: 'output.docx',
    sizeBytes: 10,
    profile: 'business-report',
    warnings: [],
  }
}

function excelSuccess(action: unknown): GenerateExcelToolOutput {
  if (action === 'list_profiles') {
    return { ok: true, action, profiles: [] }
  }
  if (action === 'list_templates') {
    return { ok: true, action, templates: [], warnings: [] }
  }
  if (action === 'fill_template') {
    return {
      ok: true,
      action,
      outputPath: 'output.xlsx',
      sizeBytes: 10,
      template: 'risk-register',
      warnings: [],
    }
  }
  return {
    ok: true,
    action: 'generate',
    outputPath: 'output.xlsx',
    sizeBytes: 10,
    profile: 'business-workbook',
    sheetNames: ['Sheet1'],
    warnings: [],
  }
}
