import assert from 'node:assert/strict'
import test from 'node:test'

import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import type { CapabilityDurableDispatchPort } from '../../contracts/durable-dispatch.js'
import { beginDiscussionContinuation, beginDiscussionSpecialistPass } from '../../core/discussion-continuation-control.js'
import { createEngineToolAdapterFactory } from '../../services/engine-capability-adapter.js'
import { governTeamRuntimeTool } from '../../team-runtime/capability-tool-adapter.js'
import {
  buildDiscussionSetupToolCallId,
  prepareDiscussionPassAttempt,
} from '../../team-runtime/discussion-pass-recovery.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

test('a recovered discussion pass crosses governed dispatch with a fresh outer identity', async () => {
  let recoveryCalls = 0
  let executions = 0
  const durable = makeDurablePort({
    recover: async () => {
      recoveryCalls += 1
      return recoveryCalls === 1
        ? { kind: 'blocked', state: 'started' }
        : { kind: 'unknown' }
    },
  })
  const rawTool = defineTool({
    name: 'converse',
    label: 'Converse',
    description: 'Runs one specialist pass.',
    parameters: Type.Object({}),
    execute: async () => {
      executions += 1
      return {
        content: [{ type: 'text' as const, text: 'recovered pass completed' }],
        details: {},
      }
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher([], {
      durable: async () => durable,
    }),
    getContext: () => ({
      contractVersion: 1,
      requestId: 'request-discussion-recovery',
      sessionId: 'session-discussion-recovery',
      runId: 'run-discussion-recovery',
      assignmentId: 'assignment-discussion-recovery',
      taskId: 'task-discussion-recovery',
      agentPath: 'agents/lead',
      authority: {
        kind: 'runtime-assignment',
        processIdentity: 'process-discussion-recovery',
      },
    }),
    modelSource: { kind: 'pi-host', id: 'team-runtime:pi-model', version: '1' },
    runtimeSource: { kind: 'engine', id: 'team-runtime:runtime-autostart', version: '1' },
    adapterFactory: createEngineToolAdapterFactory({ toolName: 'converse' }),
  })

  const running = beginDiscussionSpecialistPass(
    beginDiscussionContinuation(1_000),
    1,
    ['specialist'],
  )
  const interrupted = prepareDiscussionPassAttempt(running, 'discussion')
  await assert.rejects(
    governed.runtimeInvoker.invoke({
      toolCallId: interrupted.toolCallId,
      input: {},
      extensionContext: emptyExtensionContext(),
    }),
    (error: unknown) => hasCode(error, 'durable_replay_blocked'),
  )

  const recovered = prepareDiscussionPassAttempt(
    interrupted.continuation,
    'discussion',
  )
  const result = await governed.runtimeInvoker.invoke({
    toolCallId: recovered.toolCallId,
    input: {},
    extensionContext: emptyExtensionContext(),
  })

  assert.equal(recovered.toolCallId, 'discussion-pass:discussion:1:attempt:2')
  assert.equal(executions, 1)
  const content = (result as { content?: Array<{ type?: string }> }).content
  assert.equal(content?.[0]?.type, 'text')
})

test('a recovered discussion setup crosses governed dispatch with a fresh runtime identity', async () => {
  const firstAttempt = buildDiscussionSetupToolCallId(
    'runtime-autostart-first',
    'set-roster',
  )
  const recoveredAttempt = buildDiscussionSetupToolCallId(
    'runtime-autostart-recovered',
    'set-roster',
  )

  assert.notEqual(firstAttempt, recoveredAttempt)
  assert.equal(firstAttempt, 'runtime-autostart-first:set-roster')
  assert.equal(recoveredAttempt, 'runtime-autostart-recovered:set-roster')
})

function makeDurablePort(input: {
  readonly recover: CapabilityDurableDispatchPort['recover']
}): CapabilityDurableDispatchPort {
  return {
    derivesCapabilityEvidence: false,
    bindInvocationIdentity: async (binding) => ({
      kind: 'bound',
      invocation: binding.invocation,
    }),
    recover: input.recover,
    inspectOutcome: async () => ({ kind: 'not_found' }),
    projectionStatus: async () => 'current',
    flushProjections: async () => undefined,
    recordRequested: async () => undefined,
    recordApprovalRequested: async () => undefined,
    recordApprovalResolved: async () => undefined,
    recordPrepared: async () => undefined,
    recordStarted: async () => undefined,
    recordCommitted: async () => undefined,
    recordAccepted: async () => undefined,
    recordIndeterminate: async () => undefined,
    recordTerminal: async () => undefined,
  }
}

function emptyExtensionContext() {
  return Object.assign(Object.create(null), {
    sessionManager: {
      getSessionId: () => 'discussion-recovery-session',
      getSessionFile: () => undefined,
    },
    model: undefined,
    thinkingLevel: undefined,
  })
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
