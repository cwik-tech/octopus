import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import type { ChainState } from '../../core/types.js'
import { buildArtifactMetadata, writeMarkdownArtifact } from '../../domains/runtime/artifacts.js'
import { resolveRecoveredChainRestart } from '../../domains/runtime/runtime-owned-stage.js'
import { getChainStepArtifactPath, hasBlockedChainStepVerdict } from '../../engines/chain.js'

/**
 * Resume after a crash: a chain step that was in flight when the old attempt
 * died runs again, unless its agent recorded its own BLOCKED verdict.
 *
 * The first case is the checkpoint both failing smoke runs left behind. An
 * orphaned child team lost its parent, gave up, and saved step 1 of 1 as
 * BLOCKED with no output and no step file.
 */

function chain(currentStep: number, totalSteps: number, answered: number): ChainState {
  return {
    type: STAGE_TYPE.CHAIN,
    currentStep,
    totalSteps,
    outputs: Array.from({ length: answered }, (_unused, index) => ({
      agent: `agent-${index + 1}`,
      text: 'answer',
    })),
  }
}

test('recovery reruns a chain step an interrupted attempt left blocked', () => {
  assert.deepEqual(
    resolveRecoveredChainRestart({
      recoveryMode: true,
      stageStatus: STAGE_LIFECYCLE_STATUS.BLOCKED,
      chain: chain(1, 1, 0),
      inFlightStepBlockedByAgent: false,
    }),
    {
      stageStatus: STAGE_LIFECYCLE_STATUS.READY,
      autostartInput: { action: 'resume' },
    },
  )
})

test('recovery resumes a stopped or failed chain at its first unanswered step', () => {
  // A process stopped mid-step leaves the stage RUNNING, which cannot move to
  // READY; the chain accepts a resume from it directly.
  assert.deepEqual(
    resolveRecoveredChainRestart({
      recoveryMode: true,
      stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
      chain: chain(2, 3, 1),
      inFlightStepBlockedByAgent: false,
    }),
    {
      stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
      autostartInput: { action: 'resume' },
    },
  )
  // A failed stage arrives already reopened to READY by the existing rule.
  assert.deepEqual(
    resolveRecoveredChainRestart({
      recoveryMode: true,
      stageStatus: STAGE_LIFECYCLE_STATUS.READY,
      chain: chain(2, 2, 1),
      inFlightStepBlockedByAgent: false,
    }),
    {
      stageStatus: STAGE_LIFECYCLE_STATUS.READY,
      autostartInput: { action: 'resume' },
    },
  )
})

test('an agent verdict, a finished chain, an ordinary run and a fresh chain are left alone', () => {
  const untouched = {
    stageStatus: STAGE_LIFECYCLE_STATUS.BLOCKED,
    autostartInput: {},
  }
  assert.deepEqual(
    resolveRecoveredChainRestart({
      recoveryMode: true,
      stageStatus: STAGE_LIFECYCLE_STATUS.BLOCKED,
      chain: chain(1, 1, 0),
      inFlightStepBlockedByAgent: true,
    }),
    untouched,
  )
  assert.deepEqual(
    resolveRecoveredChainRestart({
      recoveryMode: true,
      stageStatus: STAGE_LIFECYCLE_STATUS.BLOCKED,
      chain: chain(2, 2, 2),
      inFlightStepBlockedByAgent: false,
    }),
    untouched,
  )
  assert.deepEqual(
    resolveRecoveredChainRestart({
      recoveryMode: false,
      stageStatus: STAGE_LIFECYCLE_STATUS.BLOCKED,
      chain: chain(1, 1, 0),
      inFlightStepBlockedByAgent: false,
    }),
    untouched,
  )
  // A chain that never recorded a step starts the ordinary way.
  assert.deepEqual(
    resolveRecoveredChainRestart({
      recoveryMode: true,
      stageStatus: STAGE_LIFECYCLE_STATUS.READY,
      chain: chain(0, 2, 0),
      inFlightStepBlockedByAgent: false,
    }),
    { stageStatus: STAGE_LIFECYCLE_STATUS.READY, autostartInput: {} },
  )
})

test('only a BLOCKED step file written for the agent counts as its verdict', () => {
  const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-step-verdict-'))
  const sequence = ['writer', 'editor']
  const writeStep = (stepIndex: number, status: string): void => {
    const agent = sequence[stepIndex] ?? 'unknown'
    const filePath = getChainStepArtifactPath(outputPath, stepIndex, agent)
    writeMarkdownArtifact(
      filePath,
      'step answer',
      buildArtifactMetadata({
        filePath,
        rootDir: outputPath,
        artifactType: 'handoff',
        stageType: 'chain',
        agent,
        status,
        step: stepIndex + 1,
        role: 'chain-step',
      }),
    )
  }
  try {
    assert.equal(hasBlockedChainStepVerdict(outputPath, sequence, 0), false)
    writeStep(0, 'handoff')
    assert.equal(hasBlockedChainStepVerdict(outputPath, sequence, 0), false)
    writeStep(1, 'blocked')
    assert.equal(hasBlockedChainStepVerdict(outputPath, sequence, 1), true)
    assert.equal(hasBlockedChainStepVerdict(outputPath, sequence, 2), false)
  } finally {
    fs.rmSync(outputPath, { recursive: true, force: true })
  }
})
