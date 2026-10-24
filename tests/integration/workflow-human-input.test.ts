import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { runWorkflowOutcome } from '../../workflows/runner.js'
import {
  FileSystemWorkflowStateStore,
  hashHumanInputSubmission,
} from '../../workflows/workflow-state-store.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-human-input-'))
}

function parseRoundTwoHumanHandoff(brief: string): {
  source: string
  feedback: Record<string, any>
} {
  const sourcePrefix = '## Reviewed Source\n\n'
  const feedbackMarker = '\n\n## Human Feedback\n\n'
  assert.ok(brief.startsWith(sourcePrefix))
  const feedbackIndex = brief.indexOf(feedbackMarker)
  assert.ok(feedbackIndex > sourcePrefix.length)
  return {
    source: brief.slice(sourcePrefix.length, feedbackIndex),
    feedback: JSON.parse(brief.slice(feedbackIndex + feedbackMarker.length)) as Record<string, any>,
  }
}

test('a human-input continuation passes reviewed source and feedback to the successor', async () => {
  const workspace = makeWorkspace()
  try {
    fs.mkdirSync(path.join(workspace, 'assignments', 'root-hitl'), { recursive: true })
    const templatePath = path.join(workspace, 'human-input.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: human-input-workflow
  steps:
    - id: discuss
      type: team
      team: problem-thinking-board
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
    - id: human-feedback
      type: human-in-the-loop
      input_artifact: review/round-1.md
      result_artifact: feedback/round-1.json
      handoff:
        from_step: discuss
        from_artifact: output/decomposition-plan.md
        to_artifact: review/round-1.md
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
      handoff:
        from_step: human-feedback
        from_artifact: feedback/round-1.json
        to_artifact: incoming-brief.md
  output:
    from_step: write
    artifact: final-draft.md
`)
    const parsedRegistry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    assert.equal(parsedRegistry.errors.length, 0)
    const sourceEvidence = `First round source evidence.\n${'x'.repeat(40_000)}`
    const calls: Array<{ brief: string; childSessionId?: string }> = []
    const runTeamImpl = async (input: any) => {
      calls.push({ brief: input.brief, childSessionId: input.childSessionId })
      const assignmentPath = path.join(workspace, 'assignments', input.childSessionId)
      const artifactPath = path.join(assignmentPath, input.outputArtifact)
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
      fs.writeFileSync(
        artifactPath,
        calls.length === 1 ? sourceEvidence : 'Final draft.',
      )
      return {
        text: fs.readFileSync(artifactPath, 'utf8'),
        cost: 0,
        durationMs: 1,
        artifactPath,
        assignmentPath,
        childSessionId: input.childSessionId,
        requestedResultType: input.requestedResultType,
        costTracked: true,
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
      }
    }
    const common = {
      workflowEntry: { name: 'human-input-workflow', template_path: templatePath },
      teamRegistry: new Map(parsedRegistry.entries.map((entry) => [entry.name, entry])),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'root-hitl',
      parentSessionId: 'root-hitl',
      taskId: 'task-hitl',
      productSessionId: 'session-hitl',
      persistenceMode: 'required' as const,
      runTeamImpl,
    }
    const waiting = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-one',
    })
    assert.equal(waiting.kind, 'awaiting_input')
    if (waiting.kind !== 'awaiting_input') return
    assert.deepEqual(
      waiting.interaction.eligibleRecipients,
      [],
      'a non-discussion Team successor accepts broadcast feedback without direct recipients',
    )

    const stateStore = new FileSystemWorkflowStateStore(
      path.join(workspace, 'assignments', 'root-hitl'),
    )
    await stateStore.submitHumanInput({
      expectedRevision: waiting.workflowRevision,
      interactionId: waiting.interaction.interactionId,
      expectedSourceArtifactSha256: waiting.interaction.sourceArtifact.sha256,
      submission: {
        submissionId: 'submission-one',
        mode: 'feedback',
        messages: [{
          id: 'message-one',
          text: 'Address the security trade-off.',
          recipients: 'all',
        }],
        submittedAt: '2026-08-09T12:00:00.000Z',
        canonicalHash: hashHumanInputSubmission({
          submissionId: 'submission-one',
          mode: 'feedback',
          messages: [{
            id: 'message-one',
            text: 'Address the security trade-off.',
            recipients: 'all',
          }],
        }),
      },
    })

    await assert.rejects(
      runWorkflowOutcome({
        ...common,
        executionAttemptId: 'attempt-without-continuation-admission',
        continuationMode: true,
      }),
      /has submitted human input but continuation admission ID is missing/,
    )

    const completed = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-two',
      continuationMode: true,
      continuationAdmissionRequestId: 'continuation-one',
    })
    assert.equal(completed.kind, 'terminal')
    assert.equal(calls.length, 2)
    assert.match(calls[1]!.brief, /First round source evidence\./)
    assert.match(calls[1]!.brief, /Address the security trade-off\./)
    assert.ok(Buffer.byteLength(calls[1]!.brief) < Buffer.byteLength(sourceEvidence))
    assert.match(calls[1]!.brief, /Reviewed source preview truncated/)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('two agents discuss across a human-feedback boundary and write a Markdown report', async () => {
  const workspace = makeWorkspace()
  try {
    fs.mkdirSync(path.join(workspace, 'assignments', 'two-agent-root'), { recursive: true })
    const templatePath = path.join(workspace, 'two-agent-human-input.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: two-agent-human-input
  steps:
    - id: discussion-round-1
      type: team
      team: problem-thinking-board
      stage_type: discussion
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
      runtime_overrides:
        levels:
          deliberation:
            discussion:
              participants: [contrarian, pragmatist]
              min_rounds: 1
              max_rounds: 1
    - id: human-feedback
      type: human-in-the-loop
      input_artifact: review/round-1.md
      result_artifact: feedback/round-1.json
      handoff:
        from_step: discussion-round-1
        from_artifact: output/decomposition-plan.md
        to_artifact: review/round-1.md
    - id: discussion-round-2
      type: team
      team: problem-thinking-board
      stage_type: discussion
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
      runtime_overrides:
        levels:
          deliberation:
            discussion:
              participants: [contrarian, pragmatist]
              min_rounds: 1
              max_rounds: 1
      handoff:
        from_step: human-feedback
        from_artifact: feedback/round-1.json
        to_artifact: incoming-brief.md
  output:
    from_step: discussion-round-2
    artifact: output/decomposition-plan.md
`)
    const parsedRegistry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    assert.deepEqual(parsedRegistry.errors, [])
    const calls: Array<{ brief: string; runtimeOverrides?: unknown; artifactPath: string }> = []
    const common = {
      workflowEntry: { name: 'two-agent-human-input', template_path: templatePath },
      teamRegistry: new Map(parsedRegistry.entries.map((entry) => [entry.name, entry])),
      brief: 'Assess the proposed operating model.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'two-agent-root',
      parentSessionId: 'two-agent-root',
      taskId: 'two-agent-task',
      productSessionId: 'two-agent-session',
      persistenceMode: 'required' as const,
      runTeamImpl: async (input: any) => {
        const assignmentPath = path.join(workspace, 'assignments', input.childSessionId)
        const artifactPath = path.join(assignmentPath, input.outputArtifact)
        const body = calls.length === 0
          ? [
              '# Discussion Round 1',
              '',
              '## Contrarian',
              'The operating model has an unpriced delivery risk.',
              '',
              '## Pragmatist',
              'Start with a constrained rollout to measure that risk.',
            ].join('\n')
          : [
              '# Final Report',
              '',
              '## Discussion Round 2',
              '',
              'The team incorporated the human review into its recommendation.',
              '',
              input.brief,
            ].join('\n')
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, body)
        calls.push({ brief: input.brief, runtimeOverrides: input.runtimeOverrides, artifactPath })
        return {
          text: body,
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath,
          assignmentPath,
          childSessionId: input.childSessionId,
          requestedResultType: input.requestedResultType,
          status: 'completed' as const,
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    }

    const waiting = await runWorkflowOutcome({ ...common, executionAttemptId: 'attempt-one' })
    assert.equal(waiting.kind, 'awaiting_input')
    if (waiting.kind !== 'awaiting_input') return
    assert.deepEqual(
      waiting.interaction.eligibleRecipients.map((recipient) => recipient.id),
      ['contrarian', 'pragmatist'],
    )

    const stateStore = new FileSystemWorkflowStateStore(
      path.join(workspace, 'assignments', 'two-agent-root'),
    )
    await stateStore.submitHumanInput({
      expectedRevision: waiting.workflowRevision,
      interactionId: waiting.interaction.interactionId,
      expectedSourceArtifactSha256: waiting.interaction.sourceArtifact.sha256,
      submission: {
        submissionId: 'two-agent-feedback',
        mode: 'feedback',
        messages: [{
          id: 'human-comment',
          text: 'Compare the delivery risk with the cost of a constrained rollout.',
          recipients: 'all',
        }],
        submittedAt: '2026-08-09T12:00:00.000Z',
        canonicalHash: hashHumanInputSubmission({
          submissionId: 'two-agent-feedback',
          mode: 'feedback',
          messages: [{
            id: 'human-comment',
            text: 'Compare the delivery risk with the cost of a constrained rollout.',
            recipients: 'all',
          }],
        }),
      },
    })

    const completed = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-two',
      continuationMode: true,
      continuationAdmissionRequestId: 'two-agent-continuation',
    })
    assert.equal(completed.kind, 'terminal')
    assert.equal(calls.length, 2)
    const durableAfterContinuation = await stateStore.requireSnapshot()
    assert.equal(durableAfterContinuation.state.steps[1]?.costTracked, true)
    assert.equal(durableAfterContinuation.state.totalCostUsd, 0)
    const twoAgentDiscussionOverrides = {
      stage_type: 'discussion',
      levels: {
        deliberation: {
          discussion: {
            participants: ['contrarian', 'pragmatist'],
            min_rounds: 1,
            max_rounds: 1,
          },
        },
      },
    }
    assert.deepEqual(calls[0]!.runtimeOverrides, twoAgentDiscussionOverrides)
    assert.deepEqual(calls[1]!.runtimeOverrides, twoAgentDiscussionOverrides)
    const handoff = parseRoundTwoHumanHandoff(calls[1]!.brief)
    assert.match(handoff.source, /# Discussion Round 1/)
    assert.equal(handoff.feedback.sourceArtifactSha256, waiting.interaction.sourceArtifact.sha256)
    assert.deepEqual(handoff.feedback.eligibleRecipients, waiting.interaction.eligibleRecipients)
    assert.deepEqual(handoff.feedback.messages, [{
      id: 'human-comment',
      text: 'Compare the delivery risk with the cost of a constrained rollout.',
      recipients: 'all',
    }])
    const report = fs.readFileSync(calls[1]!.artifactPath, 'utf8')
    assert.match(report, /# Final Report/)
    assert.match(report, /# Discussion Round 1/)
    assert.match(report, /Compare the delivery risk with the cost of a constrained rollout\./)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a human @mention is preserved for one frozen discussion participant', async () => {
  const workspace = makeWorkspace()
  try {
    fs.mkdirSync(path.join(workspace, 'assignments', 'mention-root'), { recursive: true })
    const templatePath = path.join(workspace, 'mention-human-input.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: mention-human-input
  steps:
    - id: discussion-round-1
      type: team
      team: problem-thinking-board
      stage_type: discussion
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
    - id: human-feedback
      type: human-in-the-loop
      input_artifact: review/round-1.md
      result_artifact: feedback/round-1.json
      handoff:
        from_step: discussion-round-1
        from_artifact: output/decomposition-plan.md
        to_artifact: review/round-1.md
    - id: discussion-round-2
      type: team
      team: problem-thinking-board
      stage_type: discussion
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
      runtime_overrides:
        levels:
          deliberation:
            discussion:
              participants: [contrarian, pragmatist]
      handoff:
        from_step: human-feedback
        from_artifact: feedback/round-1.json
        to_artifact: incoming-brief.md
  output:
    from_step: discussion-round-2
    artifact: output/decomposition-plan.md
`)
    const parsedRegistry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    assert.deepEqual(parsedRegistry.errors, [])
    const successorInputs: Array<{ brief: string; humanInputRouting?: unknown }> = []
    const common = {
      workflowEntry: { name: 'mention-human-input', template_path: templatePath },
      teamRegistry: new Map(parsedRegistry.entries.map((entry) => [entry.name, entry])),
      brief: 'Evaluate the proposal.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'mention-root',
      parentSessionId: 'mention-root',
      taskId: 'mention-task',
      productSessionId: 'mention-session',
      persistenceMode: 'required' as const,
      runTeamImpl: async (input: any) => {
        const assignmentPath = path.join(workspace, 'assignments', input.childSessionId)
        const artifactPath = path.join(assignmentPath, input.outputArtifact)
        const body = successorInputs.length === 0
          ? '# Round 1\n\nThe two participants identified a delivery risk.\n'
          : `# Final Report\n\n${input.brief}\n`
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, body)
        successorInputs.push({
          brief: input.brief,
          humanInputRouting: input.humanInputRouting,
        })
        return {
          text: body,
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath,
          assignmentPath,
          childSessionId: input.childSessionId,
          requestedResultType: input.requestedResultType,
          status: 'completed' as const,
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    }

    const waiting = await runWorkflowOutcome({ ...common, executionAttemptId: 'attempt-one' })
    assert.equal(waiting.kind, 'awaiting_input')
    if (waiting.kind !== 'awaiting_input') return
    assert.deepEqual(
      waiting.interaction.eligibleRecipients.map((recipient) => recipient.mentionToken),
      ['contrarian', 'pragmatist'],
    )

    const stateStore = new FileSystemWorkflowStateStore(
      path.join(workspace, 'assignments', 'mention-root'),
    )
    const submitted = await stateStore.submitHumanInput({
      expectedRevision: waiting.workflowRevision,
      interactionId: waiting.interaction.interactionId,
      expectedSourceArtifactSha256: waiting.interaction.sourceArtifact.sha256,
      submission: {
        submissionId: 'mention-feedback',
        mode: 'feedback',
        messages: [{
          id: 'mention-comment',
          text: '@contrarian quantify the delivery risk before recommending a rollout.',
          recipients: ['contrarian'],
        }],
        submittedAt: '2026-08-09T12:01:00.000Z',
        canonicalHash: hashHumanInputSubmission({
          submissionId: 'mention-feedback',
          mode: 'feedback',
          messages: [{
            id: 'mention-comment',
            text: '@contrarian quantify the delivery risk before recommending a rollout.',
            recipients: ['contrarian'],
          }],
        }),
      },
    })
    const interaction = submitted.steps.find((step) => step.humanInput)?.humanInput
    assert.deepEqual(interaction?.submission?.messages[0]?.recipients, ['contrarian'])

    const completed = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-two',
      continuationMode: true,
      continuationAdmissionRequestId: 'mention-continuation',
    })
    assert.equal(completed.kind, 'terminal')
    assert.equal(successorInputs.length, 2)
    const handoff = parseRoundTwoHumanHandoff(successorInputs[1]!.brief)
    assert.match(handoff.source, /# Round 1/)
    assert.equal(handoff.feedback.sourceArtifactSha256, waiting.interaction.sourceArtifact.sha256)
    assert.deepEqual(handoff.feedback.messages, [{
      id: 'mention-comment',
      text: '@contrarian quantify the delivery risk before recommending a rollout.',
      recipients: ['contrarian'],
    }])
    assert.deepEqual(successorInputs[1]!.humanInputRouting, {
      interactionId: waiting.interaction.interactionId,
      source: '# Round 1\n\nThe two participants identified a delivery risk.',
      messages: [{
        id: 'mention-comment',
        text: '@contrarian quantify the delivery risk before recommending a rollout.',
        recipients: ['contrarian'],
      }],
    })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('stage-scoped Team recipients come from the selected discussion level', async () => {
  const workspace = makeWorkspace()
  try {
    fs.mkdirSync(path.join(workspace, 'assignments', 'stage-recipient-root'), { recursive: true })
    const mixedTeamPath = path.join(workspace, 'mixed-team')
    fs.mkdirSync(mixedTeamPath, { recursive: true })
    const originalTeam = fs.readFileSync(
      path.join(process.cwd(), 'teams', 'problem-thinking-board', 'team.yaml'),
      'utf8',
    )
    const absoluteAgents = `${path.join(process.cwd(), 'agents')}/`
    const mixedTeam = originalTeam
      .replace('name: problem-thinking-board', 'name: mixed-stage-team')
      .replace('entry_level: deliberation', 'entry_level: intake')
      .replaceAll('../../agents/', absoluteAgents)
      .replace('levels:\n  - id: deliberation', `levels:
  - id: intake
    name: Intake
    order: 0
    stage:
      type: chain
      sequence: [problem-decomposer]
      config:
        handoff_format: markdown
        preserve_initial_input: true
        constraints:
          max_time_minutes: 10
          agent_timeout_minutes: 3
          max_budget_usd: 8
        output:
          format: output/decomposition-plan.md
          user_review: false
  - id: deliberation`)
    fs.writeFileSync(path.join(mixedTeamPath, 'team.yaml'), mixedTeam)

    const templatePath = path.join(workspace, 'stage-recipient.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: stage-recipient
  steps:
    - id: prepare
      type: team
      team: problem-thinking-board
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
    - id: human-feedback
      type: human-in-the-loop
      input_artifact: review/source.md
      result_artifact: feedback/review.json
      handoff:
        from_step: prepare
        from_artifact: output/decomposition-plan.md
        to_artifact: review/source.md
    - id: discuss
      type: team
      team: mixed-stage-team
      stage_type: discussion
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
      handoff:
        from_step: human-feedback
        from_artifact: feedback/review.json
        to_artifact: incoming-brief.md
  output:
    from_step: discuss
    artifact: output/decomposition-plan.md
`)
    const parsedRegistry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    const originalEntry = parsedRegistry.entries.find((entry) => entry.name === 'problem-thinking-board')
    if (!originalEntry || originalEntry.type !== 'team') {
      throw new Error('Expected problem-thinking-board Team registry entry')
    }
    const teamRegistry = new Map(parsedRegistry.entries.map((entry) => [entry.name, entry]))
    teamRegistry.set('mixed-stage-team', {
      ...originalEntry,
      name: 'mixed-stage-team',
      team_path: mixedTeamPath,
    })

    const waiting = await runWorkflowOutcome({
      workflowEntry: { name: 'stage-recipient', template_path: templatePath },
      teamRegistry,
      brief: 'Prepare a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'stage-recipient-root',
      parentSessionId: 'stage-recipient-root',
      taskId: 'stage-recipient-task',
      productSessionId: 'stage-recipient-session',
      executionAttemptId: 'stage-recipient-attempt',
      persistenceMode: 'required',
      runTeamImpl: async (input: any) => {
        const assignmentPath = path.join(workspace, 'assignments', input.childSessionId)
        const artifactPath = path.join(assignmentPath, input.outputArtifact)
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, 'Prepared source.')
        return {
          text: 'Prepared source.',
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath,
          assignmentPath,
          childSessionId: input.childSessionId,
          requestedResultType: input.requestedResultType,
          status: 'completed' as const,
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    assert.equal(waiting.kind, 'awaiting_input')
    if (waiting.kind !== 'awaiting_input') return
    assert.deepEqual(
      waiting.interaction.eligibleRecipients.slice(0, 2).map((recipient) => recipient.id),
      ['contrarian', 'pragmatist'],
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a human-input continuation passes source and feedback to an Agent successor', async () => {
  const workspace = makeWorkspace()
  try {
    fs.mkdirSync(path.join(workspace, 'assignments', 'agent-successor-root'), { recursive: true })
    const templatePath = path.join(workspace, 'agent-successor.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: agent-successor
  steps:
    - id: prepare
      type: team
      team: problem-thinking-board
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
    - id: human-feedback
      type: human-in-the-loop
      input_artifact: review/source.md
      result_artifact: feedback/review.json
      handoff:
        from_step: prepare
        from_artifact: output/decomposition-plan.md
        to_artifact: review/source.md
    - id: revise
      type: agent
      team: problem-thinking-board
      agent: contrarian
      stage_type: discussion
      input_artifact: incoming-brief.md
      result_artifact: final.md
      handoff:
        from_step: human-feedback
        from_artifact: feedback/review.json
        to_artifact: incoming-brief.md
  output:
    from_step: revise
    artifact: final.md
`)
    const parsedRegistry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    const agentMessages: string[] = []
    const common = {
      workflowEntry: { name: 'agent-successor', template_path: templatePath },
      teamRegistry: new Map(parsedRegistry.entries.map((entry) => [entry.name, entry])),
      brief: 'Prepare a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'agent-successor-root',
      parentSessionId: 'agent-successor-root',
      taskId: 'agent-successor-task',
      productSessionId: 'agent-successor-session',
      persistenceMode: 'required' as const,
      runTeamImpl: async (input: any) => {
        const assignmentPath = path.join(workspace, 'assignments', input.childSessionId)
        const artifactPath = path.join(assignmentPath, input.outputArtifact)
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, 'Agent-reviewed source.')
        return {
          text: 'Agent-reviewed source.', cost: 0, costTracked: true, durationMs: 1,
          artifactPath, assignmentPath, childSessionId: input.childSessionId,
          requestedResultType: input.requestedResultType, status: 'completed' as const,
          succeeded: true, exitCode: 0, exitSignal: null,
        }
      },
      runAgentImpl: async (input: any) => {
        agentMessages.push(input.userMessage)
        return {
          text: '# Final\n\nRevised.', cost: 0, costTracked: true, durationMs: 1,
          inputTokens: 0, outputTokens: 0, contextTokens: 0, model: 'test',
        }
      },
    }

    const waiting = await runWorkflowOutcome({ ...common, executionAttemptId: 'agent-attempt-one' })
    assert.equal(waiting.kind, 'awaiting_input')
    if (waiting.kind !== 'awaiting_input') return
    assert.deepEqual(waiting.interaction.eligibleRecipients.map((recipient) => recipient.id), ['contrarian'])
    const stateStore = new FileSystemWorkflowStateStore(
      path.join(workspace, 'assignments', 'agent-successor-root'),
    )
    const messages = [{ id: 'agent-feedback-message', text: 'Challenge the cost assumption.', recipients: ['contrarian'] }]
    await stateStore.submitHumanInput({
      expectedRevision: waiting.workflowRevision,
      interactionId: waiting.interaction.interactionId,
      expectedSourceArtifactSha256: waiting.interaction.sourceArtifact.sha256,
      submission: {
        submissionId: 'agent-feedback', mode: 'feedback', messages,
        submittedAt: '2026-08-09T12:02:00.000Z',
        canonicalHash: hashHumanInputSubmission({ submissionId: 'agent-feedback', mode: 'feedback', messages }),
      },
    })

    const completed = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'agent-attempt-two',
      continuationMode: true,
      continuationAdmissionRequestId: 'agent-continuation',
    })
    assert.equal(completed.kind, 'terminal')
    assert.equal(agentMessages.length, 1)
    assert.match(agentMessages[0]!, /Agent-reviewed source\./)
    assert.match(agentMessages[0]!, /Challenge the cost assumption\./)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
