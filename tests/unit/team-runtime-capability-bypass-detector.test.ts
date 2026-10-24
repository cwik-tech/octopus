import assert from 'node:assert/strict'
import test from 'node:test'

import { TeamRuntimeCapabilityBypassDetector } from '../../team-runtime/capability-bypass-detector.js'

test('Team Runtime bypass detector fails closed for an ungoverned tool call', () => {
  const detector = new TeamRuntimeCapabilityBypassDetector()
  detector.replaceGovernedTools(['read', 'dispatch'])

  const decision = detector.observe({
    toolName: 'extension_bypass',
    toolCallId: 'bypass-call-1',
  })

  assert.deepEqual(decision, {
    // Beside the block, because Pi is owed the block and the reader is owed a
    // sentence, and only a code can select one
    // (`contracts/capability-policy-denial.ts`).
    code: 'ungoverned_tool_call',
    result: {
      block: true,
      terminate: true,
      reason: "Tool 'extension_bypass' has no Team Runtime capability registration.",
    },
  })
})

test('Team Runtime bypass detector leaves governed calls to dispatcher admission', () => {
  const detector = new TeamRuntimeCapabilityBypassDetector()
  detector.replaceGovernedTools(['read', 'dispatch'])

  const decision = detector.observe({
    toolName: 'dispatch',
    toolCallId: 'governed-call-1',
  })

  assert.equal(decision, undefined)
})

test('Team Runtime bypass detector fails closed when Pi resolves a substituted same-name tool', () => {
  const detector = new TeamRuntimeCapabilityBypassDetector({
    isGovernedRegistrationActive: () => false,
  })
  detector.replaceGovernedTools(['read'])

  const decision = detector.observe({
    toolName: 'read',
    toolCallId: 'substituted-read-call',
  })

  assert.deepEqual(decision, {
    // Its own code, not the ungoverned one: the team does grant this tool, and
    // telling the reader to add it to the team would send them to a setting
    // that is already correct.
    code: 'shadowed_tool_registration',
    result: {
      block: true,
      terminate: true,
      reason: "Tool 'read' is not the active Team Runtime capability registration.",
    },
  })
})

test('Team Runtime bypass detector fails closed when Pi registration provenance is unavailable', () => {
  const detector = new TeamRuntimeCapabilityBypassDetector({
    isGovernedRegistrationActive: () => {
      throw new Error('Pi registry unavailable')
    },
  })
  detector.replaceGovernedTools(['read'])

  const decision = detector.observe({
    toolName: 'read',
    toolCallId: 'unverifiable-read-call',
  })

  assert.deepEqual(decision, {
    code: 'shadowed_tool_registration',
    result: {
      block: true,
      terminate: true,
      reason: "Tool 'read' is not the active Team Runtime capability registration.",
    },
  })
})
