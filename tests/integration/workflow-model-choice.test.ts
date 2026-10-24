/**
 * An unattended workflow never consents on the user's behalf.
 *
 * When a step's explicit model fails in a way a user could authorize a retry
 * for, the run *waits* instead of ending: committed predecessor work stays
 * committed, the worker slot is released, and the owning run says what decision
 * it is waiting for. When the user approves, exactly one step runs again, on
 * exactly the pair they were shown, and nothing before it is replayed.
 *
 * Driven through the real runner and the real durable state store, with a fake
 * team implementation so the failure is deterministic. The approval travels as
 * an authorization — never as a team configuration — which is what this asserts
 * by reading what the retried step was actually given.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { runWorkflowOutcome } from '../../workflows/runner.js'
import { FileSystemWorkflowStateStore } from '../../workflows/workflow-state-store.js'
import { getRuntimeApprovedModelChoice } from '../../domains/provider/approved-model-choice.js'
import type { ModelChoiceOffer } from '../../contracts/model-choice.js'

const FAILED_CHOICE = { provider: 'anthropic', model: 'claude-opus-4-6' }
const PROPOSED_DEFAULT = { provider: 'connection:abc', model: 'gpt-5.4-mini' }

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-model-choice-'))
}

function writeTemplate(workspace: string): string {
  const templatePath = path.join(workspace, 'model-choice.yaml')
  fs.writeFileSync(templatePath, `
workflow:
  id: model-choice-workflow
  steps:
    - id: research
      type: team
      team: problem-thinking-board
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
      handoff:
        from_step: research
        from_artifact: output/decomposition-plan.md
        to_artifact: incoming-brief.md
  output:
    from_step: write
    artifact: final-draft.md
`)
  return templatePath
}

test('an eligible model failure suspends the run, and one approval reruns only the affected step', async () => {
  const workspace = makeWorkspace()
  const assignmentPath = path.join(workspace, 'assignments', 'root-choice')
  try {
    fs.mkdirSync(assignmentPath, { recursive: true })
    const templatePath = writeTemplate(workspace)
    const parsedRegistry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    assert.equal(parsedRegistry.errors.length, 0)

    const calls: string[] = []
    /** What the second step was authorized with when it actually ran. */
    let authorizationSeenByStep: ReturnType<typeof getRuntimeApprovedModelChoice>
    let failWriteStep = true
    const runTeamImpl = async (input: any) => {
      calls.push(input.childSessionId)
      const childAssignment = path.join(workspace, 'assignments', input.childSessionId)
      if (input.outputArtifact === 'final-draft.md') {
        if (failWriteStep) {
          fs.mkdirSync(childAssignment, { recursive: true })
          throw new Error('provider refused: invalid_api_key')
        }
        authorizationSeenByStep = getRuntimeApprovedModelChoice()
      }
      const artifactPath = path.join(childAssignment, input.outputArtifact)
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
      fs.writeFileSync(artifactPath, `Result for ${input.outputArtifact}.`)
      return {
        text: fs.readFileSync(artifactPath, 'utf8'),
        cost: 0,
        durationMs: 1,
        artifactPath,
        assignmentPath: childAssignment,
        childSessionId: input.childSessionId,
        requestedResultType: input.requestedResultType,
        costTracked: true,
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
      }
    }

    const offers: ModelChoiceOffer[] = []
    const modelChoiceEvaluator = {
      async evaluate(input: {
        stepId: string
        taskId: string
        sessionId: string
        expectedRevision: string
      }): Promise<ModelChoiceOffer | undefined> {
        const offer: ModelChoiceOffer = {
          offerId: `offer-${input.stepId}`,
          scope: { kind: 'task', sessionId: input.sessionId, taskId: input.taskId },
          agentName: 'writer',
          expectedRevision: input.expectedRevision,
          failedChoice: FAILED_CHOICE,
          proposedDefault: PROPOSED_DEFAULT,
          reason: 'missing-credential',
        }
        offers.push(offer)
        return offer
      },
    }

    const common = {
      workflowEntry: { name: 'model-choice-workflow', template_path: templatePath },
      teamRegistry: new Map(parsedRegistry.entries.map((entry) => [entry.name, entry])),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'root-choice',
      parentSessionId: 'root-choice',
      taskId: 'task-choice',
      productSessionId: 'session-choice',
      persistenceMode: 'required' as const,
      runTeamImpl,
      modelChoiceEvaluator,
    }

    const waiting = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-one',
    })

    assert.equal(waiting.kind, 'awaiting_model_choice')
    if (waiting.kind !== 'awaiting_model_choice') return
    assert.equal(waiting.stepId, 'write')
    assert.deepEqual(waiting.offer.failedChoice, FAILED_CHOICE)
    assert.deepEqual(waiting.offer.proposedDefault, PROPOSED_DEFAULT)
    assert.equal(calls.length, 2, 'both steps were attempted once')

    // The durable record shows a wait, with the predecessor's work intact.
    const reopened = await new FileSystemWorkflowStateStore(assignmentPath).requireSnapshot()
    assert.equal(reopened.state.status, 'awaiting_model_choice')
    const research = reopened.state.steps.find((step) => step.stepId === 'research')
    const write = reopened.state.steps.find((step) => step.stepId === 'write')
    assert.equal(research?.status, 'completed', 'committed work stays committed')
    assert.equal(write?.status, 'awaiting_model_choice')
    assert.deepEqual(write?.modelChoice, waiting.offer)

    // The user approves. The offer becomes an authorization on that one step.
    const store = new FileSystemWorkflowStateStore(assignmentPath)
    await store.approveModelChoice({
      expectedRevision: waiting.workflowRevision,
      offerId: waiting.offer.offerId,
    })

    failWriteStep = false
    const resumed = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-two',
      recoveryMode: true,
    })

    assert.equal(resumed.kind, 'terminal')
    if (resumed.kind !== 'terminal') return
    assert.equal(resumed.result.status, 'completed')

    // Only the affected step ran again.
    assert.equal(calls.length, 3, 'the committed predecessor was not replayed')

    // And it ran under an authorization, not a configuration.
    assert.deepEqual(authorizationSeenByStep, {
      offerId: waiting.offer.offerId,
      agentName: 'writer',
      failedChoice: FAILED_CHOICE,
      proposedDefault: PROPOSED_DEFAULT,
    })
    // The authorization is scoped to that dispatch; nothing is left published.
    assert.equal(getRuntimeApprovedModelChoice(), undefined)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a failure nobody may authorize a retry for still ends the run', async () => {
  const workspace = makeWorkspace()
  const assignmentPath = path.join(workspace, 'assignments', 'root-plain')
  try {
    fs.mkdirSync(assignmentPath, { recursive: true })
    const templatePath = writeTemplate(workspace)
    const parsedRegistry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))

    const runTeamImpl = async (input: any) => {
      const childAssignment = path.join(workspace, 'assignments', input.childSessionId)
      if (input.outputArtifact === 'final-draft.md') {
        fs.mkdirSync(childAssignment, { recursive: true })
        throw new Error('the team ran out of time')
      }
      const artifactPath = path.join(childAssignment, input.outputArtifact)
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
      fs.writeFileSync(artifactPath, 'Research result.')
      return {
        text: 'Research result.',
        cost: 0,
        durationMs: 1,
        artifactPath,
        assignmentPath: childAssignment,
        childSessionId: input.childSessionId,
        requestedResultType: input.requestedResultType,
        costTracked: true,
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
      }
    }

    await assert.rejects(
      runWorkflowOutcome({
      workflowEntry: { name: 'model-choice-workflow', template_path: templatePath },
      teamRegistry: new Map(parsedRegistry.entries.map((entry) => [entry.name, entry])),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'root-plain',
      parentSessionId: 'root-plain',
      taskId: 'task-plain',
      productSessionId: 'session-plain',
      persistenceMode: 'required' as const,
      executionAttemptId: 'attempt-one',
      runTeamImpl,
      // No offer is earned: the failure is not one a different model fixes.
      modelChoiceEvaluator: { evaluate: async () => undefined },
      }),
      /the team ran out of time/,
      'an unearned failure ends the run exactly as it did before',
    )

    const state = await new FileSystemWorkflowStateStore(assignmentPath).requireSnapshot()
    assert.equal(state.state.status, 'failed')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
