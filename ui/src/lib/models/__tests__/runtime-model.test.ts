import { expect, test } from 'vitest'

import {
  buildExecutionGroups,
  buildExecutionProjection,
  buildExecutionProjectionFromRootEvents,
  formatRelativeTime,
  formatTimestamp,
  getPreferredArtifactPaths,
  parseMarkdownArtifact,
  type EngineEventEnvelope,
  type RunSummary,
} from '@/lib/models/runtime-model'

test('buildExecutionGroups keeps parent and child runs under one root execution', () => {
  const runs: RunSummary[] = [
    {
      id: 'child-run',
      assignmentPath: '/workspace/assignments/child-run',
      artifactPaths: [],
      jobTitle: null,
      parentRunId: 'root-run',
      rootRunId: 'root-run',
      startedAt: '2026-05-01T12:01:00.000Z',
      status: 'completed',
      team: 'child-team',
      updatedAt: '2026-05-01T12:03:00.000Z',
    },
    {
      id: 'root-run',
      assignmentPath: '/workspace/assignments/root-run',
      artifactPaths: [],
      jobTitle: 'Write a crisp board update for the weekly leadership meeting.',
      rootRunId: 'root-run',
      startedAt: '2026-05-01T12:00:00.000Z',
      status: 'active',
      team: 'root-team',
      updatedAt: '2026-05-01T12:02:00.000Z',
    },
  ]

  const groups = buildExecutionGroups(runs)

  expect(groups).toHaveLength(1)
  expect(groups[0]).toMatchObject({
    childRunCount: 1,
    id: 'root-run',
    jobTitle: 'Write a crisp board update for the weekly leadership meeting.',
    rootRunId: 'root-run',
    status: 'active',
    team: 'root-team',
  })
  expect(groups[0]?.latestRunId).toBe('child-run')
})

test('buildExecutionProjection derives story items and artifact candidates from events', () => {
  const group = buildExecutionGroups([
    {
      id: 'root-run',
      assignmentPath: '/workspace/assignments/root-run',
      artifactPaths: ['output/report.md'],
      jobTitle: 'Create a board-ready report.',
      rootRunId: 'root-run',
      startedAt: '2026-05-01T12:00:00.000Z',
      status: 'completed',
      team: 'root-team',
      updatedAt: '2026-05-01T12:03:00.000Z',
    },
  ])[0]
  const events: EngineEventEnvelope[] = [
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:00.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.session_started',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'root-team',
      payload: {},
    },
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:02:00.000Z',
      tenant_id: 'local',
      category: 'artifact',
      type: 'artifact.written',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'root-team',
      payload: {
        artifact_type: 'report',
        path: 'output/report.md',
        title: 'Report',
      },
    },
  ]

  const projection = buildExecutionProjection(group!, { 'root-run': events })

  expect(projection.rawEventCount).toBe(2)
  expect(projection.story.map((item) => item.kind)).toEqual(['run', 'artifact'])
  expect(projection.artifacts[0]).toMatchObject({
    artifactType: 'report',
    path: 'output/report.md',
    runId: 'root-run',
  })
  expect(projection.finalArtifactCandidates[0]?.path).toBe('output/report.md')
})

test('buildExecutionProjection shows workflow activity without discussion response bodies', () => {
  const events: EngineEventEnvelope[] = [
    {
      schema_version: 1,
      timestamp: '2026-07-21T12:00:00.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.session_started',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'review-team',
      payload: {},
    },
    {
      schema_version: 1,
      timestamp: '2026-07-21T12:00:01.000Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.start',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'review-team',
      payload: { agent_name: 'Contrarian' },
    },
    {
      schema_version: 1,
      timestamp: '2026-07-21T12:00:05.000Z',
      tenant_id: 'local',
      category: 'stage',
      type: 'discussion.message',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'review-team',
      payload: {
        agent_name: 'Contrarian',
        text: 'This full response belongs in chat only.',
      },
    },
    {
      schema_version: 1,
      timestamp: '2026-07-21T12:00:05.001Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.end',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'review-team',
      payload: {
        agent_name: 'Contrarian',
        duration_ms: 5_000,
        model: 'fixture-model',
      },
    },
    {
      schema_version: 1,
      timestamp: '2026-07-21T12:00:06.000Z',
      tenant_id: 'local',
      category: 'tool',
      type: 'tool.execution_logged',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'review-team',
      payload: { agent_name: 'Researcher', tool_name: 'browser' },
    },
    {
      schema_version: 1,
      timestamp: '2026-07-21T12:00:07.000Z',
      tenant_id: 'local',
      category: 'gate',
      type: 'gate.transition',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'review-team',
      payload: { from: 'review', to: 'writing' },
    },
  ]

  const projection = buildExecutionProjectionFromRootEvents('root-run', events)
  const titles = projection.story.map((item) => item.title)

  expect(titles).toContain('Contrarian started')
  expect(titles).toContain('Contrarian finished · 5s · fixture-model')
  expect(titles).toContain('Researcher used tool browser')
  expect(titles).toContain('Stage advanced: review → writing')
  expect(JSON.stringify(projection.story)).not.toContain(
    'This full response belongs in chat only.',
  )
})

test('buildExecutionProjection renders durable human-input lifecycle events', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-08-09T12:00:00.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'run.awaiting_input',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'workflow:review',
      payload: { interaction_id: 'feedback-1', step_id: 'human-feedback' },
    },
    {
      schema_version: 1,
      timestamp: '2026-08-09T12:00:01.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'workflow.human_input.requested',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'workflow:review',
      payload: {
        interaction_id: 'feedback-1',
        step_id: 'human-feedback',
        recipients: [{ id: 'writer' }, { id: 'reviewer' }],
      },
    },
    {
      schema_version: 1,
      timestamp: '2026-08-09T12:00:02.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'workflow.human_input.message',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'workflow:review',
      payload: {
        interaction_id: 'feedback-1',
        step_id: 'human-feedback',
        submission_id: 'submission-1',
        message_id: 'message-1',
        recipients: ['writer'],
      },
    },
    {
      schema_version: 1,
      timestamp: '2026-08-09T12:00:03.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'workflow.human_input.submitted',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'workflow:review',
      payload: {
        interaction_id: 'feedback-1',
        step_id: 'human-feedback',
        submission_id: 'submission-1',
        mode: 'feedback',
        message_count: 1,
      },
    },
  ])

  expect(projection.story.map((item) => item.title)).toEqual([
    'Workflow awaiting human input',
    'Human input requested from 2 participants',
    'Human feedback sent to Writer',
    'Human feedback submitted · 1 message',
  ])
})

test('buildExecutionProjection renders agent failures as timeline errors', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [{
    schema_version: 1,
    timestamp: '2026-07-21T12:00:00.000Z',
    tenant_id: 'local',
    category: 'agent',
    type: 'agent.fail',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'review-team',
    payload: {
      agent_name: 'Contrarian',
      error: 'Provider unavailable',
    },
  }])

  expect(projection.story[0]).toMatchObject({
    errorText: 'Provider unavailable',
    kind: 'error',
    title: 'Contrarian failed',
  })
})

test('buildExecutionProjection renders YouTube Gemini fallbacks with their safe error code', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [{
    schema_version: 1,
    timestamp: '2026-08-13T23:01:24.022Z',
    tenant_id: 'local',
    category: 'tool',
    type: 'youtube.manual.analysis_fallback',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'youtube-extraction',
    level_id: 'extract',
    stage_type: 'chain',
    payload: {
      action: 'prepare_manual',
      error_code: 'gemini_invalid_response',
      analysis_mode: 'transcript',
      manual_run_id: 'manual-1',
      emitter_name: 'youtube-tool-service',
    },
  }])

  expect(projection.story).toEqual([
    expect.objectContaining({
      badges: ['tool', 'extract', 'gemini_invalid_response'],
      detail: 'Fell back to transcript analysis',
      errorText: 'gemini_invalid_response',
      kind: 'error',
      title: 'Gemini analysis failed · gemini_invalid_response',
    }),
  ])
})

test('buildExecutionProjection records transcript analysis selected without Gemini as informational', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [{
    schema_version: 1,
    timestamp: '2026-08-13T23:01:24.022Z',
    tenant_id: 'local',
    category: 'tool',
    type: 'youtube.manual.analysis_fallback',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'youtube-extraction',
    level_id: 'extract',
    stage_type: 'chain',
    payload: {
      action: 'prepare_manual',
      error_code: 'gemini_key_missing',
      analysis_mode: 'transcript',
      manual_run_id: 'manual-1',
      emitter_name: 'youtube-tool-service',
    },
  }])

  expect(projection.story).toEqual([
    expect.objectContaining({
      badges: ['tool', 'extract', 'gemini_key_missing'],
      detail: 'Gemini is not configured; using transcript analysis',
      errorText: null,
      kind: 'delegation',
      title: 'Transcript analysis selected · gemini_key_missing',
    }),
  ])
})

test('buildExecutionProjection renders YouTube media extraction milestones', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-08-13T23:01:24.022Z',
      tenant_id: 'local',
      category: 'tool',
      type: 'youtube.manual.video_downloaded',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'youtube-extraction',
      level_id: 'extract',
      stage_type: 'chain',
      payload: {
        action: 'build_manual',
        byte_length: 156_562_017,
        duration_seconds: 998.8,
        width: 1920,
        height: 1080,
      },
    },
    {
      schema_version: 1,
      timestamp: '2026-08-13T23:02:24.022Z',
      tenant_id: 'local',
      category: 'tool',
      type: 'youtube.manual.key_frames_extracted',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'youtube-extraction',
      level_id: 'extract',
      stage_type: 'chain',
      payload: { action: 'build_manual', frame_count: 14 },
    },
  ])

  expect(projection.story.map((item) => item.title)).toEqual([
    'Video downloaded · 149.3 MB · 1920×1080 · 16m 39s',
    'Key frames extracted · 14 frames',
  ])
})

function youtubeMilestone(
  type: string,
  payload: Record<string, unknown> = {},
  timestamp = '2026-08-13T23:01:24.022Z',
) {
  return {
    schema_version: 1 as const,
    timestamp,
    tenant_id: 'local',
    category: 'tool' as const,
    type,
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'youtube-extraction',
    level_id: 'extract',
    stage_type: 'chain',
    payload: { action: 'build_manual', ...payload },
  }
}

test('buildExecutionProjection renders every YouTube manual milestone', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    youtubeMilestone('youtube.manual.video_download_started', {}, '2026-08-13T23:00:00.000Z'),
    youtubeMilestone('youtube.manual.key_frames_extraction_started', {}, '2026-08-13T23:00:01.000Z'),
    youtubeMilestone('youtube.manual.manual_publication_started', {}, '2026-08-13T23:00:02.000Z'),
    youtubeMilestone('youtube.manual.manual_markdown_written', {}, '2026-08-13T23:00:03.000Z'),
    youtubeMilestone('youtube.manual.manual_docx_written', {}, '2026-08-13T23:00:04.000Z'),
    youtubeMilestone('youtube.manual.source_video_retained', {}, '2026-08-13T23:00:05.000Z'),
    youtubeMilestone('youtube.manual.temporary_media_cleaned', {}, '2026-08-13T23:00:06.000Z'),
  ])

  expect(projection.story.map((item) => ({ kind: item.kind, title: item.title }))).toEqual([
    { kind: 'delegation', title: 'Downloading video' },
    { kind: 'delegation', title: 'Extracting key frames' },
    { kind: 'delegation', title: 'Publishing screenshot-rich manual' },
    { kind: 'completion', title: 'Markdown manual created' },
    { kind: 'completion', title: 'Word manual created' },
    { kind: 'completion', title: 'Source video retained' },
    { kind: 'completion', title: 'Temporary video cleaned up' },
  ])
})

test('buildExecutionProjection scales media sizes and durations past the megabyte and minute', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    youtubeMilestone(
      'youtube.manual.video_downloaded',
      { byte_length: 2_469_606_195, duration_seconds: 5_400, width: 3840, height: 2160 },
      '2026-08-13T23:00:00.000Z',
    ),
    youtubeMilestone(
      'youtube.manual.video_downloaded',
      { byte_length: 900, duration_seconds: 45.4, width: 640, height: 360 },
      '2026-08-13T23:00:01.000Z',
    ),
    youtubeMilestone(
      'youtube.manual.video_downloaded',
      { byte_length: 4_096, duration_seconds: 0 },
      '2026-08-13T23:00:02.000Z',
    ),
  ])

  expect(projection.story.map((item) => item.title)).toEqual([
    'Video downloaded · 2.3 GB · 3840×2160 · 1h 30m',
    'Video downloaded · 900 B · 640×360 · 45s',
    // Dimensions are omitted rather than rendered as a partial pair, and a
    // zero-second duration is still a fact worth showing.
    'Video downloaded · 4.0 KB · 0s',
  ])
})

test('buildExecutionProjection omits milestone details that the payload does not carry', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    youtubeMilestone('youtube.manual.video_downloaded', {}, '2026-08-13T23:00:00.000Z'),
    youtubeMilestone(
      'youtube.manual.video_downloaded',
      { byte_length: -1, duration_seconds: -5, width: 1920 },
      '2026-08-13T23:00:01.000Z',
    ),
    youtubeMilestone('youtube.manual.key_frames_extracted', {}, '2026-08-13T23:00:02.000Z'),
    youtubeMilestone(
      'youtube.manual.key_frames_extracted',
      { frame_count: 1 },
      '2026-08-13T23:00:03.000Z',
    ),
    youtubeMilestone(
      'youtube.manual.key_frames_extracted',
      { frame_count: 0 },
      '2026-08-13T23:00:04.000Z',
    ),
  ])

  expect(projection.story.map((item) => item.title)).toEqual([
    'Video downloaded',
    'Video downloaded',
    'Key frames extracted',
    'Key frames extracted · 1 frame',
    'Key frames extracted · 0 frames',
  ])
})

test('buildExecutionProjection reports agent durations in readable units', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-08-13T23:00:00.000Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.end',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'youtube-extraction',
      payload: { agent_name: 'youtube-extractor', duration_ms: 486_000 },
    },
    {
      schema_version: 1,
      timestamp: '2026-08-13T23:00:01.000Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.end',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'youtube-extraction',
      payload: { agent_name: 'quick-agent', duration_ms: 850 },
    },
  ])

  expect(projection.story.map((item) => item.title)).toEqual([
    'youtube-extractor finished · 8m 6s',
    'quick-agent finished · 850ms',
  ])
})

test('a run says when an Agent it started ran on the application default', () => {
  // Most runs are chains and pipelines, and this projection is what a person
  // reads for them — there is no discussion roster to fall back on. A dispatch
  // that inherited the application default said only "started", so the run
  // recorded which model did the work and showed none of it. A gate validator
  // is the sharpest case: it decides whether the run advances.
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-09-09T12:00:00.000Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.start',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'writing-team',
      stage_type: 'chain',
      payload: {
        agent_name: 'gate-validator',
        model: 'app-default-gate-model',
        provider: 'openai',
        model_selection: {
          provider: 'openai',
          model: 'app-default-gate-model',
          source: 'app-default',
          reason: 'agent-default',
          caller: 'agent',
        },
      },
    },
  ])

  const started = projection.story.find((entry) =>
    entry.title.includes('Gate Validator') || entry.title.includes('gate-validator'),
  )
  expect(started?.title).toMatch(/app default/i)
  expect(started?.title).toContain('openai / app-default-gate-model')
  // Readable at a glance, not only in full. The process timeline renders each
  // row as a truncated single line with the whole string in a tooltip
  // (`process-timeline-table.tsx:266-282`), so a default-use notice placed
  // after the agent and the verb is clipped away — the screen then shows a
  // dispatch and says nothing about the model that ran it. Leading with it is
  // what survives that truncation.
  expect(started?.title.startsWith('App default')).toBe(true)
})

test('a run tells an Agent’s reflection apart from its own turn', () => {
  // The same Agent runs twice on the same pair: once for its turn, once to
  // reflect on the session afterwards. Both are `agent.start`, so both rendered
  // the identical line — and a person reading "Scout started on the app default
  // X" twice cannot tell which model use was which. Disclosure that cannot be
  // attributed to the work it did is not disclosure.
  const selection = {
    provider: 'openai',
    model: 'app-default-model',
    source: 'app-default',
    reason: 'agent-default',
    caller: 'agent',
  }
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-09-09T12:00:00.000Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.start',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'insight-desk',
      stage_type: 'broadcast',
      payload: { agent_name: 'scout', model: selection.model, provider: selection.provider, model_selection: selection },
    },
    {
      schema_version: 1,
      timestamp: '2026-09-09T12:00:05.000Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.start',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'insight-desk',
      payload: {
        agent_name: 'scout',
        // What caused this dispatch, on the field that already means that.
        trigger_tool: 'experience_reflection',
        model: selection.model,
        provider: selection.provider,
        model_selection: selection,
      },
    },
  ])

  const titles = projection.story
    .filter((entry) => /app default/i.test(entry.title))
    .map((entry) => entry.title)
  expect(titles).toHaveLength(2)
  // Both name the pair; only one says it was the reflection.
  expect(titles.every((title) => title.includes('openai / app-default-model'))).toBe(true)
  expect(titles.filter((title) => /reflect/i.test(title))).toHaveLength(1)
  // A start, not a finish. This row appears when the dispatch goes out, so it
  // must not claim the reflection already happened.
  expect(titles.some((title) => /started a session reflection/.test(title))).toBe(true)
  expect(titles.some((title) => /reflected on the session/.test(title))).toBe(false)
})

test('a run does not claim default use for an Agent that chose its own model', () => {
  // An Agent that named its pair made a choice, and describing that as
  // inheriting one would be the same falsehood in the other direction.
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-09-09T12:00:00.000Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.start',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'writing-team',
      stage_type: 'chain',
      payload: {
        agent_name: 'gate-validator',
        model: 'validator-own-model',
        provider: 'anthropic',
        model_selection: {
          provider: 'anthropic',
          model: 'validator-own-model',
          source: 'agent',
          reason: 'explicit-agent-choice',
          caller: 'agent',
        },
      },
    },
  ])

  const started = projection.story.find((entry) =>
    entry.title.includes('Gate Validator') || entry.title.includes('gate-validator'),
  )
  // Asserted to exist first. Without this, a start that never reached the story
  // at all would satisfy the negative below and this test would pass for the
  // one reason it is meant to rule out.
  expect(started).toBeDefined()
  // Case-insensitive, because the marker now leads with a capital. A
  // `toContain('app default')` check would silently stop catching a false
  // notice the moment the wording changed case.
  expect(started?.title).not.toMatch(/app default/i)
})

test('buildExecutionProjection preserves exact research actor attribution across lifecycle and artifacts', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-07-25T12:00:00.000Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.start',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'deep-research-report',
      payload: {
        agent_id: 'flavor-uniqueness',
        agent_name: 'web-researcher',
        agent_display_name: 'Flavor Uniqueness Analyst',
        activity_scope_id: 'flavor-uniqueness',
      },
    },
    {
      schema_version: 1,
      timestamp: '2026-07-25T12:00:01.000Z',
      tenant_id: 'local',
      category: 'artifact',
      type: 'artifact.written',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'deep-research-report',
      payload: {
        path: 'research/observations/flavor-uniqueness/receipt.json',
        artifact_type: 'observation-receipt',
        agent_id: 'flavor-uniqueness',
        agent_name: 'Flavor Uniqueness Analyst',
        agent_base_name: 'web-researcher',
        activity_scope_id: 'flavor-uniqueness',
        emitter_name: 'source-observation-store',
      },
    },
  ])

  expect(projection.story).toHaveLength(2)
  expect(projection.story[0]?.actor).toEqual({
    id: 'flavor-uniqueness',
    name: 'Flavor Uniqueness Analyst',
    baseName: 'web-researcher',
    activityScopeId: 'flavor-uniqueness',
    emitterName: null,
  })
  expect(projection.story[1]?.actor).toEqual({
    id: 'flavor-uniqueness',
    name: 'Flavor Uniqueness Analyst',
    baseName: 'web-researcher',
    activityScopeId: 'flavor-uniqueness',
    emitterName: 'source-observation-store',
  })
  expect(projection.agents).toMatchObject([
    {
      name: 'Flavor Uniqueness Analyst',
      runId: 'root-run',
    },
  ])
})

test('buildExecutionProjection infers only canonical historical research lane paths', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-07-25T12:00:00.000Z',
      tenant_id: 'local',
      category: 'artifact',
      type: 'artifact.written',
      run_id: 'root-run',
      root_run_id: 'root-run',
      payload: {
        path: 'research/observations/public-favoritism/receipt.json',
        artifact_type: 'observation-receipt',
      },
    },
    {
      schema_version: 1,
      timestamp: '2026-07-25T12:00:01.000Z',
      tenant_id: 'local',
      category: 'artifact',
      type: 'artifact.written',
      run_id: 'root-run',
      root_run_id: 'root-run',
      payload: {
        path: 'output/report.md',
        artifact_type: 'report',
      },
    },
  ])

  expect(projection.story[0]?.actor).toMatchObject({
    id: 'public-favoritism',
    name: 'Public Favoritism',
  })
  expect(projection.story[1]?.actor).toBeUndefined()
})

test('buildExecutionProjection surfaces delegation failures as red timeline steps', () => {
  const group = buildExecutionGroups([
    {
      id: 'root-run',
      assignmentPath: '/workspace/assignments/root-run',
      artifactPaths: ['delegation-writing-team-result.md'],
      jobTitle: 'Write the final draft.',
      rootRunId: 'root-run',
      startedAt: '2026-05-01T12:00:00.000Z',
      status: 'failed',
      team: 'reception-desk',
      updatedAt: '2026-05-01T12:03:00.000Z',
    },
  ])[0]

  const events: EngineEventEnvelope[] = [
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:02:00.000Z',
      tenant_id: 'local',
      category: 'delegation',
      type: 'delegation.event',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'reception-desk',
      payload: {
        from: 'receptionist',
        status: 'failed',
        to: 'writing-team',
        to_team: 'writing-team',
        error: 'Team run failed: writing-team',
      },
    },
  ]

  const projection = buildExecutionProjection(group!, { 'root-run': events })
  const errorItem = projection.story.find((item) => item.kind === 'error')

  expect(errorItem).toMatchObject({
    detail: 'writing-team reported a runtime failure',
    errorText: 'Team run failed: writing-team',
    title: 'Delegation failed',
  })
})

test('buildExecutionProjectionFromRootEvents reconstructs child depth without duplicate streams', () => {
  const events: EngineEventEnvelope[] = [
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:00.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.session_started',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'root-team',
      payload: {},
    },
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:01:00.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.session_started',
      run_id: 'child-run',
      root_run_id: 'root-run',
      parent_run_id: 'root-run',
      team: 'child-team',
      payload: {},
    },
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:02:00.000Z',
      tenant_id: 'local',
      category: 'artifact',
      type: 'artifact.written',
      run_id: 'child-run',
      root_run_id: 'root-run',
      parent_run_id: 'root-run',
      team: 'child-team',
      payload: { path: 'child-result.md', artifact_type: 'result' },
    },
  ]

  const projection = buildExecutionProjectionFromRootEvents('root-run', events)
  const childStart = projection.story.find(
    (item) => item.runId === 'child-run' && item.kind === 'run',
  )

  expect(projection.rawEventCount).toBe(3)
  expect(projection.story).toHaveLength(3)
  expect(childStart).toMatchObject({ depth: 1, team: 'child-team' })
  expect(projection.artifacts[0]).toMatchObject({
    path: 'child-result.md',
    runId: 'child-run',
  })
})

test('buildExecutionProjection surfaces root failures with their error message', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:03:00.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.failed',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'root-team',
      payload: { error: 'Provider connection failed' },
    },
  ])

  expect(projection.story[0]).toMatchObject({
    errorText: 'Provider connection failed',
    kind: 'error',
    title: 'Root Team run failed',
  })
})

test('buildExecutionProjection names each run so a workflow and its delegate do not read alike', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:00.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.session_started',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'workflow:youtube-manual-generation',
      payload: {},
    },
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:01.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.session_started',
      run_id: 'child-run',
      root_run_id: 'root-run',
      parent_run_id: 'root-run',
      team: 'youtube-extraction',
      payload: {},
    },
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:02.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'run.completed',
      run_id: 'child-run',
      root_run_id: 'root-run',
      team: 'youtube-extraction',
      payload: {},
    },
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:03.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'run.completed',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'workflow:youtube-manual-generation',
      payload: {},
    },
  ])

  expect(projection.story.map((item) => item.title)).toEqual([
    'Workflow run started',
    'Youtube Extraction run started',
    'Youtube Extraction run completed',
    'Workflow run completed',
  ])
})

test('buildExecutionProjection keeps one row per artifact when a runtime rewrites the same file', () => {
  const rewrite = (timestamp: string) => ({
    schema_version: 1 as const,
    timestamp,
    tenant_id: 'local',
    category: 'artifact' as const,
    type: 'artifact.written',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'youtube-extraction',
    payload: {
      path: 'output/youtube-manifest.json',
      artifact_type: 'result',
    },
  })

  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    rewrite('2026-05-01T12:00:00.000Z'),
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:01.000Z',
      tenant_id: 'local',
      category: 'artifact',
      type: 'artifact.written',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'youtube-extraction',
      payload: { path: 'output/transcripts/abc.md', artifact_type: 'result' },
    },
    rewrite('2026-05-01T12:00:02.000Z'),
  ])

  // Three writes, two files: the manifest keeps only its newest row, which is
  // the revision the artifact link actually opens.
  expect(projection.rawEventCount).toBe(3)
  expect(
    projection.story.map((item) => ({
      timestamp: item.timestamp,
      title: item.title,
    })),
  ).toEqual([
    {
      timestamp: '2026-05-01T12:00:01.000Z',
      title: 'output/transcripts/abc.md written',
    },
    {
      timestamp: '2026-05-01T12:00:02.000Z',
      title: 'output/youtube-manifest.json written',
    },
  ])
})

test('buildExecutionProjection attributes a child run event to the child, not the root', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:00.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.session_started',
      run_id: 'child-run',
      root_run_id: 'root-run',
      parent_run_id: 'root-run',
      team: 'youtube-extraction',
      payload: {},
    },
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:01.000Z',
      tenant_id: 'local',
      category: 'tool',
      type: 'tool.execution_logged',
      run_id: 'child-run',
      root_run_id: 'root-run',
      team: null,
      payload: { tool_name: 'handoff' },
    },
  ])

  // The event carries no team of its own; it must inherit the child run's team
  // and depth rather than being absorbed by the root.
  expect(projection.story[1]).toMatchObject({
    depth: 1,
    runId: 'child-run',
    team: 'youtube-extraction',
    title: 'youtube-extraction used tool handoff',
  })
})

test('buildExecutionProjection distinguishes running vs waiting runs from active agents', () => {
  const group = buildExecutionGroups([
    {
      id: 'root-run',
      assignmentPath: '/workspace/assignments/root-run',
      artifactPaths: [],
      jobTitle: 'Write the final draft.',
      rootRunId: 'root-run',
      startedAt: '2026-05-01T12:00:00.000Z',
      status: 'active',
      team: 'reception-desk',
      updatedAt: '2026-05-01T12:03:00.000Z',
    },
    {
      id: 'child-run',
      assignmentPath: '/workspace/assignments/child-run',
      artifactPaths: [],
      jobTitle: null,
      parentRunId: 'root-run',
      rootRunId: 'root-run',
      startedAt: '2026-05-01T12:01:00.000Z',
      status: 'active',
      team: 'writing-team',
      updatedAt: '2026-05-01T12:04:00.000Z',
    },
  ])[0]

  const events: EngineEventEnvelope[] = [
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:00:00.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.session_started',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'reception-desk',
      payload: {},
    },
    {
      schema_version: 1,
      timestamp: '2026-05-01T12:02:00.000Z',
      tenant_id: 'local',
      category: 'agent',
      type: 'agent.start',
      run_id: 'child-run',
      root_run_id: 'root-run',
      team: 'writing-team',
      level_id: 'brief-and-draft',
      stage_type: 'chain',
      payload: {
        agent_name: 'writer',
      },
    },
  ]

  const projection = buildExecutionProjection(group!, {
    'child-run': [events[1]!],
    'root-run': [events[0]!],
  })

  const rootNode = projection.runNodes.find((node) => node.runId === 'root-run')
  const childNode = projection.runNodes.find((node) => node.runId === 'child-run')

  expect(rootNode).toMatchObject({
    executionState: 'waiting',
  })
  expect(childNode).toMatchObject({
    activeAgentNames: ['writer'],
    currentLevelId: 'brief-and-draft',
    currentStageType: 'chain',
    executionState: 'running',
  })
})

test('buildExecutionGroups marks older unfinished executions incomplete and keeps the newest one active', () => {
  const groups = buildExecutionGroups([
    {
      id: 'older-root',
      assignmentPath: '/workspace/assignments/older-root',
      artifactPaths: [],
      jobTitle: 'Older unfinished execution.',
      rootRunId: 'older-root',
      startedAt: '2026-05-01T12:00:00.000Z',
      status: 'incomplete',
      team: 'root-team',
      updatedAt: '2026-05-01T12:02:00.000Z',
    },
    {
      id: 'newer-root',
      assignmentPath: '/workspace/assignments/newer-root',
      artifactPaths: [],
      jobTitle: 'Newest unfinished execution.',
      rootRunId: 'newer-root',
      startedAt: '2026-05-01T12:05:00.000Z',
      status: 'incomplete',
      team: 'root-team',
      updatedAt: '2026-05-01T12:06:00.000Z',
    },
  ])

  expect(groups.map((group) => ({ id: group.id, status: group.status }))).toEqual([
    { id: 'newer-root', status: 'active' },
    { id: 'older-root', status: 'incomplete' },
  ])
})

test('buildExecutionGroups allows only one active root even when multiple roots report active', () => {
  const groups = buildExecutionGroups([
    {
      id: 'older-root',
      assignmentPath: '/workspace/assignments/older-root',
      artifactPaths: [],
      jobTitle: 'Older apparently active execution.',
      rootRunId: 'older-root',
      startedAt: '2026-05-01T12:00:00.000Z',
      status: 'active',
      team: 'root-team',
      updatedAt: '2026-05-01T12:02:00.000Z',
    },
    {
      id: 'newer-root',
      assignmentPath: '/workspace/assignments/newer-root',
      artifactPaths: [],
      jobTitle: 'Newest apparently active execution.',
      rootRunId: 'newer-root',
      startedAt: '2026-05-01T12:05:00.000Z',
      status: 'active',
      team: 'root-team',
      updatedAt: '2026-05-01T12:06:00.000Z',
    },
  ])

  expect(groups.map((group) => ({ id: group.id, status: group.status }))).toEqual([
    { id: 'newer-root', status: 'active' },
    { id: 'older-root', status: 'incomplete' },
  ])
})

for (const status of ['blocked', 'cancelled'] as const) {
  test(`buildExecutionGroups preserves terminal ${status} status`, () => {
    const groups = buildExecutionGroups([{
      id: `${status}-root`,
      assignmentPath: `/workspace/assignments/${status}-root`,
      artifactPaths: [],
      jobTitle: `${status} execution.`,
      rootRunId: `${status}-root`,
      startedAt: '2026-05-01T12:00:00.000Z',
      status,
      team: 'root-team',
      updatedAt: '2026-05-01T12:03:00.000Z',
    }])

    expect(groups[0]?.status).toBe(status)
    const projection = buildExecutionProjection(groups[0]!, {})
    expect(projection.runNodes[0]?.executionState).toBe(status)
  })
}

test('buildExecutionProjection surfaces incomplete runs explicitly', () => {
  const group = buildExecutionGroups([
    {
      id: 'root-run',
      assignmentPath: '/workspace/assignments/root-run',
      artifactPaths: [],
      jobTitle: 'Interrupted execution.',
      rootRunId: 'root-run',
      startedAt: '2026-05-01T12:00:00.000Z',
      status: 'incomplete',
      team: 'root-team',
      updatedAt: '2026-05-01T12:03:00.000Z',
    },
  ])[0]

  const projection = buildExecutionProjection(group!, {
    'root-run': [{
      schema_version: 1,
      timestamp: '2026-05-01T12:00:00.000Z',
      tenant_id: 'local',
      category: 'run',
      type: 'run.session_started',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'root-team',
      payload: {},
    }],
  })

  expect(projection.runNodes[0]).toMatchObject({
    executionState: 'incomplete',
    status: 'incomplete',
  })
})

/* ------------------------------------------------------------------ */
/*  parseMarkdownArtifact                                              */
/* ------------------------------------------------------------------ */

test('parseMarkdownArtifact returns the full content when no frontmatter exists', () => {
  const result = parseMarkdownArtifact('Hello world\nNo frontmatter here.')

  expect(result).toEqual({
    body: 'Hello world\nNo frontmatter here.',
    hasFrontmatter: false,
    metadata: {},
  })
})

test('parseMarkdownArtifact extracts frontmatter metadata with colons in values', () => {
  const content = [
    '---',
    'title: My Report',
    'author: Alice: The Lead',
    'date: 2026-05-01',
    '',
    '---',
    'Here is the report body.',
  ].join('\n')

  const result = parseMarkdownArtifact(content)

  expect(result).toMatchObject({
    hasFrontmatter: true,
    metadata: {
      title: 'My Report',
      author: 'Alice: The Lead',
      date: '2026-05-01',
    },
    body: 'Here is the report body.',
  })
})

test('parseMarkdownArtifact strips quoted string values', () => {
  const content = [
    '---',
    'title: "Double Quoted"',
    "author: 'Single Quoted'",
    '---',
    'body',
  ].join('\n')

  const result = parseMarkdownArtifact(content)

  expect(result.metadata).toMatchObject({
    title: 'Double Quoted',
    author: 'Single Quoted',
  })
})

test('parseMarkdownArtifact skips blank and comment lines in frontmatter', () => {
  const content = [
    '---',
    '',
    '# A comment',
    'key: value',
    '---',
    'body',
  ].join('\n')

  const result = parseMarkdownArtifact(content)

  expect(result.metadata).toEqual({ key: 'value' })
  expect(result.body).toBe('body')
})

test('parseMarkdownArtifact handles empty body gracefully', () => {
  const content = '---\ntitle: Only Frontmatter\n---'

  const result = parseMarkdownArtifact(content)

  expect(result.hasFrontmatter).toBe(true)
  expect(result.metadata.title).toBe('Only Frontmatter')
  expect(result.body).toBe('')
})

/* ------------------------------------------------------------------ */
/*  getPreferredArtifactPaths                                          */
/* ------------------------------------------------------------------ */

test('getPreferredArtifactPaths orders preferred names first', () => {
  const paths = [
    'output/report.md',
    'output/minutes.md',
    'output/brief.md',
    'output/notes.txt',
  ]

  const result = getPreferredArtifactPaths(paths)

  expect(result).toEqual([
    'output/report.md',
    'output/minutes.md',
    'output/brief.md',
    'output/notes.txt',
  ])
})

test('getPreferredArtifactPaths sorts non-priority paths alphabetically among themselves', () => {
  const paths = ['z.md', 'a.md', 'm.md']

  const result = getPreferredArtifactPaths(paths)

  expect(result).toEqual(['a.md', 'm.md', 'z.md'])
})

test('getPreferredArtifactPaths handles empty input', () => {
  expect(getPreferredArtifactPaths([])).toEqual([])
})

test('getPreferredArtifactPaths still sorts known names even with extra paths', () => {
  const paths = [
    'output/brief.md',
    'other/z.md',
    'output/report.md',
    'other/a.md',
  ]

  const result = getPreferredArtifactPaths(paths)

  // report.md and brief.md come first (by priority), then the rest sorted alphabetically
  expect(result).toEqual([
    'output/report.md',
    'output/brief.md',
    'other/a.md',
    'other/z.md',
  ])
})

/* ------------------------------------------------------------------ */
/*  formatTimestamp                                                    */
/* ------------------------------------------------------------------ */

test('formatTimestamp returns "n/a" for null or undefined', () => {
  expect(formatTimestamp(null)).toBe('n/a')
  expect(formatTimestamp(undefined)).toBe('n/a')
  expect(formatTimestamp('')).toBe('n/a')
})

test('formatTimestamp formats a valid ISO timestamp into a human-readable string', () => {
  const result = formatTimestamp('2026-05-01T12:30:45.000Z')

  // day is numeric (not zero-padded); timezone is pinned to UTC in test-setup.
  expect(result).toMatch(/May 1\b/i)
  expect(result).toMatch(/12:30:45/i)
  expect(result).not.toBe('n/a')
})

/* ------------------------------------------------------------------ */
/*  formatRelativeTime                                                 */
/* ------------------------------------------------------------------ */

test('formatRelativeTime returns "n/a" for null or undefined', () => {
  expect(formatRelativeTime(null)).toBe('n/a')
  expect(formatRelativeTime(undefined)).toBe('n/a')
  expect(formatRelativeTime('')).toBe('n/a')
})

test('formatRelativeTime returns "just now" for timestamps within a minute', () => {
  const recent = new Date(Date.now() + 30_000).toISOString()
  expect(formatRelativeTime(recent)).toBe('just now')
})

test('formatRelativeTime returns "Nm ago" for timestamps within an hour', () => {
  const past = new Date(Date.now() - 45 * 60_000).toISOString()
  const result = formatRelativeTime(past)
  expect(result).toMatch(/45m ago/)
})

test('formatRelativeTime returns "Nh ago" for timestamps within a day', () => {
  const past = new Date(Date.now() - 3 * 3_600_000).toISOString()
  expect(formatRelativeTime(past)).toMatch(/3h ago/)
})

test('formatRelativeTime returns "Nd ago" for timestamps older than a day', () => {
  const past = new Date(Date.now() - 5 * 24 * 3_600_000).toISOString()
  expect(formatRelativeTime(past)).toMatch(/5d ago/)
})

test('buildExecutionProjection renders the durable model-choice decision and its approved retry', () => {
  // What a person must still be able to read after the run is over: the pair
  // that could not run, the pair they agreed to, and that the second attempt
  // used the application default rather than the Agent's own setting.
  const projection = buildExecutionProjectionFromRootEvents('root-run', [
    {
      schema_version: 1,
      timestamp: '2026-09-06T12:00:00.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'agent.fail',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'workflow:packaged-smoke',
      payload: {
        agent_name: 'defaultrecoveryworker',
        error: 'Connection absentconnection is not configured',
      },
    },
    {
      schema_version: 1,
      timestamp: '2026-09-06T12:00:01.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'run.awaiting_model_choice',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'workflow:packaged-smoke',
      payload: {
        step_id: 'finalize',
        offer_id: 'offer-1',
        agent_name: 'defaultrecoveryworker',
        requested_provider: 'connection:absentconnection',
        requested_model: 'fake/never-configured',
        proposed_provider: 'connection:fixture',
        proposed_model: 'fake/default',
      },
    },
    {
      schema_version: 1,
      timestamp: '2026-09-06T12:00:02.000Z',
      tenant_id: 'local',
      category: 'runtime',
      type: 'agent.start',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'workflow:packaged-smoke',
      payload: {
        agent_name: 'defaultrecoveryworker',
        model_selection: {
          provider: 'connection:fixture',
          model: 'fake/default',
          source: 'app-default',
          reason: 'user-approved-retry',
          caller: 'agent',
          requestedProvider: 'connection:absentconnection',
          requestedModel: 'fake/never-configured',
        },
      },
    },
  ])

  // The agent is named as the run recorded it, so these read as the durable
  // record rather than a re-derivation.
  expect(projection.story.map((item) => item.title)).toEqual([
    'defaultrecoveryworker failed',
    'defaultrecoveryworker stopped for a model choice · connection:absentconnection / fake/never-configured could not run · offered connection:fixture / fake/default',
    'App default · defaultrecoveryworker started on connection:fixture / fake/default · instead of connection:absentconnection / fake/never-configured',
  ])
})

test('buildExecutionProjection says the runtime refused a tool call and why', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [{
    schema_version: 1,
    timestamp: '2026-09-12T10:00:00.000Z',
    tenant_id: 'local',
    category: 'tool',
    type: 'tool.execution_failed',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'writing-team',
    level_id: 'draft',
    payload: {
      tool_name: 'dispatch',
      agent_name: 'Research Lead',
      is_error: true,
      blocked_by_capability_policy: true,
      policy_code: 'tool_not_allowed_in_level',
      reason: "Tool 'dispatch' is not available in the current level.",
    },
  }])

  // Written out, not built from the constant the projection read. Asserting a
  // sentence against itself passes for any sentence, which is how a refusal
  // came to be explained by copy that told the reader to stop looking.
  expect(projection.story[0]?.title).toBe(
    'Research Lead was not allowed to use dispatch · The agent asked for something this stage does not offer. Add the tool to this stage, or move the step to the stage that already has it.',
  )
  expect(projection.story[0]?.title).not.toContain('failed using tool')
  // Not an error: nothing broke, the runtime declined the call. The kind is
  // what the table paints the row's accent from.
  expect(projection.story[0]?.kind).toBe('refusal')
})

test('buildExecutionProjection explains a call refused before any policy ran', () => {
  // The bypass gate's own record. It carries `blocked_capability_bypass` rather
  // than the policy flag (`team-runtime/index.ts:4870`), and reading only the
  // policy flag sent this row through the failure arm: "Research Lead failed
  // using tool bash", with the reason discarded.
  const projection = buildExecutionProjectionFromRootEvents('root-run', [{
    schema_version: 1,
    timestamp: '2026-09-12T10:00:00.000Z',
    tenant_id: 'local',
    category: 'tool',
    type: 'tool.execution_failed',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'writing-team',
    level_id: 'draft',
    payload: {
      tool_name: 'bash',
      agent_name: 'Research Lead',
      is_error: true,
      blocked_capability_bypass: true,
      policy_code: 'ungoverned_tool_call',
      reason: "Tool 'bash' has no Team Runtime capability registration.",
    },
  }])

  const item = projection.story[0]
  expect(item?.title).toBe(
    'Research Lead was not allowed to use bash · The agent asked for a tool this run does not offer at all, so nothing ran. Add it to the team and the stage, or drop it from the agent instructions.',
  )
  expect(item?.title).not.toContain('failed using tool')
  expect(item?.kind).toBe('refusal')
  expect(item?.badges).toContain('ungoverned_tool_call')
  expect(item?.detail).toBe("Tool 'bash' has no Team Runtime capability registration.")
})

test('buildExecutionProjection explains a call the runtime refused on safety grounds', () => {
  // The third gate's own record. The governed Pi tools refuse a destructive
  // shell command and a path outside the run's folder inside the tool adapter
  // (`team-runtime/governed-pi-tools.ts:224`, `:235`), which the dispatcher
  // resolves ahead of the capability policy — so neither policy flag is on the
  // record and reading only those two sent this row through the failure arm as
  // "Research Lead failed using tool bash".
  const projection = buildExecutionProjectionFromRootEvents('root-run', [{
    schema_version: 1,
    timestamp: '2026-09-12T10:00:00.000Z',
    tenant_id: 'local',
    category: 'tool',
    type: 'tool.execution_failed',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'writing-team',
    level_id: 'draft',
    payload: {
      tool_name: 'bash',
      agent_name: 'Research Lead',
      is_error: true,
      blocked_tool_safety: true,
      policy_code: 'unsafe_bash_command',
      reason: 'The bash command exceeds the Team Runtime risk boundary.',
    },
  }])

  const item = projection.story[0]
  // Written out rather than read from the contract: a sentence asserted against
  // itself passes for any sentence, including one that tells a reader to go and
  // change a setting that does not exist.
  expect(item?.title).toBe(
    'Research Lead was not allowed to use bash · The command the agent asked to run could delete files, take administrator rights or run something downloaded from the web, so the run stopped it. This is the runtime keeping your machine safe, not a setting to change.',
  )
  expect(item?.title).not.toContain('failed using tool')
  expect(item?.kind).toBe('refusal')
  expect(item?.badges).toContain('unsafe_bash_command')
  expect(item?.detail).toBe('The bash command exceeds the Team Runtime risk boundary.')
})

test('buildExecutionProjection explains a file the run was refused outside its folder', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [{
    schema_version: 1,
    timestamp: '2026-09-12T10:00:00.000Z',
    tenant_id: 'local',
    category: 'tool',
    type: 'tool.execution_failed',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'writing-team',
    level_id: 'draft',
    payload: {
      tool_name: 'write',
      agent_name: 'Research Lead',
      is_error: true,
      blocked_tool_safety: true,
      policy_code: 'tool_path_outside_workspace',
      reason: 'The tool path must remain inside the Team Runtime workspace.',
    },
  }])

  const item = projection.story[0]
  expect(item?.title).toBe(
    'Research Lead was not allowed to use write · The agent reached for a file outside the folder this run owns, so nothing was read or written. This is the runtime keeping the run inside its own folder, not a setting to change.',
  )
  expect(item?.kind).toBe('refusal')
  expect(item?.title).not.toContain('failed using tool')
})

test('buildExecutionProjection treats a benign refusal as a refusal, not an error', () => {
  // Both of these end with the run carrying on. A row marked `error` is painted
  // in the error accent (`ui/src/components/process-timeline-table.tsx:92`),
  // which would tell a reader something broke.
  const benign = [
    {
      code: 'duplicate_level_tool',
      sentence:
        'The agent reached for the same stage tool twice in one turn. The first use counted and the repeat was dropped.',
    },
    {
      code: 'post_advance_tool_denied',
      sentence:
        'The run had already moved to the next stage, so the request arrived too late. The work carries on in the new stage.',
    },
  ] as const

  for (const refusal of benign) {
    const projection = buildExecutionProjectionFromRootEvents('root-run', [{
      schema_version: 1,
      timestamp: '2026-09-12T10:00:00.000Z',
      tenant_id: 'local',
      category: 'tool',
      type: 'tool.execution_failed',
      run_id: 'root-run',
      root_run_id: 'root-run',
      team: 'writing-team',
      level_id: 'draft',
      payload: {
        tool_name: 'dispatch',
        agent_name: 'Research Lead',
        is_error: true,
        blocked_by_capability_policy: true,
        policy_code: refusal.code,
        reason: 'Runtime prose a reader never sees.',
      },
    }])

    const item = projection.story[0]
    expect(item?.kind).toBe('refusal')
    expect(item?.kind).not.toBe('error')
    expect(item?.title).toBe(
      `Research Lead was not allowed to use dispatch · ${refusal.sentence}`,
    )
  }
})

test('buildExecutionProjection keeps the refusal code and runtime reason off the title', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [{
    schema_version: 1,
    timestamp: '2026-09-12T10:00:00.000Z',
    tenant_id: 'local',
    category: 'tool',
    type: 'tool.execution_failed',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'writing-team',
    level_id: 'draft',
    payload: {
      tool_name: 'dispatch',
      agent_name: 'Research Lead',
      is_error: true,
      blocked_by_capability_policy: true,
      policy_code: 'tool_not_allowed_for_agent',
      reason: "Tool 'dispatch' is not allowed for agent 'coordinator'.",
    },
  }])

  const item = projection.story[0]
  expect(item?.title).not.toContain('tool_not_allowed_for_agent')
  expect(item?.title).not.toContain("Tool 'dispatch' is not allowed for agent")
  expect(item?.badges).toContain('tool_not_allowed_for_agent')
  expect(item?.detail).toBe("Tool 'dispatch' is not allowed for agent 'coordinator'.")
})

test('buildExecutionProjection still reports a genuine tool failure as a failure', () => {
  const projection = buildExecutionProjectionFromRootEvents('root-run', [{
    schema_version: 1,
    timestamp: '2026-09-12T10:00:00.000Z',
    tenant_id: 'local',
    category: 'tool',
    type: 'tool.execution_failed',
    run_id: 'root-run',
    root_run_id: 'root-run',
    team: 'writing-team',
    payload: {
      tool_name: 'dispatch',
      agent_name: 'Research Lead',
      is_error: true,
      error: 'Sub-team exited before reporting.',
    },
  }])

  expect(projection.story[0]).toMatchObject({
    errorText: 'Sub-team exited before reporting.',
    kind: 'error',
    title: 'Research Lead failed using tool dispatch',
  })
})
