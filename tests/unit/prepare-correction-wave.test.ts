import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

const SCRIPT_PATH = path.join(
  process.cwd(),
  'teams',
  'research-team',
  'scripts',
  'prepare-correction-wave.mjs',
)

function createWorkspace(options: {
  correctionWave?: number
  taskIds?: string[]
  remainingMs?: number
  timings?: 'fast' | 'missing' | 'malformed' | 'failed-run'
} = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-correction-wave-'))
  const inputPath = path.join(workspace, 'research', 'quality', 'current-verdict.json')
  const outputPath = path.join(workspace, 'research', 'correction-context.json')
  const plan = {
    schemaVersion: 1,
    planId: 'approved-plan-one',
    requestId: 'request-one',
    maxDurationMinutes: 20,
    approvalHash: 'approved-plan-hash-one',
    tasks: [
      {
        id: 'T1',
        title: 'Establish the evidence baseline',
        dependsOn: [],
      },
      {
        id: 'T2',
        title: 'Verify the disputed\nmarket claim',
        dependsOn: ['T1'],
      },
      {
        id: 'T3',
        title: 'Reconcile the final comparison',
        dependsOn: ['T1', 'T2'],
      },
    ],
  }
  const verdict = createVerdict(
    options.correctionWave ?? 0,
    options.taskIds ?? ['T3', 'T2'],
  )

  writeJson(path.join(workspace, 'research', 'approved-plan.json'), plan)
  writeJson(path.join(workspace, 'research', 'runtime-limits.json'), {
    schemaVersion: 1,
    planId: plan.planId,
    maxDurationMinutes: plan.maxDurationMinutes,
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    deadlineAt: new Date(Date.now() + (options.remainingMs ?? 10 * 60_000)).toISOString(),
  })
  writeJson(path.join(workspace, 'research', 'evidence', 'current-manifest.json'), {
    schemaVersion: 1,
    latestByTask: {
      T1: 'research/evidence/wave-0/T1.json',
      T2: 'research/evidence/wave-0/T2.json',
      T3: 'research/evidence/wave-0/T3.json',
    },
  })
  writeJson(inputPath, verdict)
  fs.writeFileSync(path.join(workspace, 'research-package.md'), '# Original report\n')
  writeJson(path.join(workspace, 'research', 'quality', 'deterministic-verdict.json'), {
    schemaVersion: 1,
    decision: 'REVISE',
    summary: 'The current report requires targeted evidence corrections.',
  })
  fs.writeFileSync(
    path.join(workspace, 'research', 'plan.md'),
    '# Original executable plan\n',
  )
  writeTimingFixtures(workspace, options.timings ?? 'fast')

  return { inputPath, outputPath, plan, verdict, workspace }
}

function writeTimingFixtures(
  workspace: string,
  timings: 'fast' | 'missing' | 'malformed' | 'failed-run',
): void {
  if (timings === 'missing') return
  const researchLog = path.join(
    workspace,
    'research',
    'evidence',
    'wave-0',
    'logs',
    'agent-runs.jsonl',
  )
  const agentLog = path.join(workspace, 'logs', 'agent-runs.jsonl')
  if (timings === 'malformed') {
    writeText(researchLog, '{not-json\n{"event":"start"\n')
    writeText(agentLog, '{"event":"end","duration_ms":\nnot-json\n')
    return
  }
  const researchSpanMs = timings === 'failed-run' ? 447_000 : 45_000
  const synthesisMs = timings === 'failed-run' ? 126_409 : 40_000
  const criticMs = timings === 'failed-run' ? 86_809 : 60_000
  const researchStartedAt = Date.parse('2026-07-19T04:33:07.000Z')
  writeJsonl(researchLog, [
    agentRunEvent('web-researcher', 'start', researchStartedAt),
    agentRunEvent('web-researcher', 'end', researchStartedAt + researchSpanMs, researchSpanMs),
  ])
  writeJsonl(agentLog, [
    agentRunEvent('research-synthesizer', 'end', researchStartedAt, synthesisMs),
    agentRunEvent('evidence-critic', 'end', researchStartedAt, criticMs),
  ])
}

function agentRunEvent(
  agentName: string,
  event: 'start' | 'end',
  timestampMs: number,
  durationMs?: number,
): Record<string, unknown> {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    event,
    agent_name: agentName,
    status: event === 'end' ? 'completed' : 'active',
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
  }
}

function writeJsonl(filePath: string, entries: readonly Record<string, unknown>[]): void {
  writeText(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

function createVerdict(correctionWave: number, taskIds: string[]) {
  return {
    schemaVersion: 1,
    verdictId: `verdict-wave-${correctionWave}`,
    correctionWave,
    decision: 'REVISE',
    findings: [],
    correctionRequests: [
      {
        schemaVersion: 1,
        id: `correction-wave-${correctionWave}`,
        type: 'verify_source',
        claimIds: ['claim-disputed'],
        taskIds,
        sectionIds: ['section-market'],
        question: 'Which sources resolve the disputed claim?',
        acceptanceCriteria: ['Use direct, independent evidence.'],
        impactScope: 'local',
      },
    ],
    reviewedAt: '2026-07-17T12:00:00.000Z',
  }
}

function runScript(workspace: string, inputPath: string, outputPath: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    env: {
      ...process.env,
      TRANSFORM_INPUT: inputPath,
      TRANSFORM_OUTPUT: outputPath,
      WORKSPACE_PATH: workspace,
    },
    encoding: 'utf8',
  })
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function hashCanonicalValue(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

test('materializes only targeted tasks with wave-specific paths and provenance', () => {
  const fixture = createWorkspace()
  try {
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)
    assert.equal(run.status, 0, run.stderr)

    const executablePlan = fs.readFileSync(
      path.join(fixture.workspace, 'research', 'plan.md'),
      'utf8',
    )
    assert.equal(
      executablePlan,
      [
        '# Plan: Deep Research Correction Wave 1',
        '**Status:** executing',
        '',
        '### S1: Targeted Corrections Wave 1',
        '#### T2: Verify the disputed market claim',
        '- **Agent:** web-researcher',
        '- **Status:** pending',
        '- **Validate:** false',
        '- **Depends on:** none',
        '- **Gate:** false',
        '- **Result file:** research/evidence/wave-1/T2.json',
        '',
        '#### T3: Reconcile the final comparison',
        '- **Agent:** web-researcher',
        '- **Status:** pending',
        '- **Validate:** false',
        '- **Depends on:** T2',
        '- **Gate:** false',
        '- **Result file:** research/evidence/wave-1/T3.json',
        '',
      ].join('\n'),
    )
    assert.doesNotMatch(executablePlan, /#### T1:/)

    assert.deepEqual(
      readJson(path.join(fixture.workspace, 'research', 'quality', 'verdict-wave-0.json')),
      fixture.verdict,
    )
    assert.equal(
      fs.readFileSync(
        path.join(fixture.workspace, 'research', 'reports', 'report-wave-0.md'),
        'utf8',
      ),
      '# Original report\n',
    )
    assert.equal(
      fs.readFileSync(
        path.join(fixture.workspace, 'research', 'plans', 'plan-wave-0.md'),
        'utf8',
      ),
      '# Original executable plan\n',
    )

    assert.deepEqual(readJson(fixture.outputPath), {
      schemaVersion: 1,
      wave: 1,
      approvedPlanHash: fixture.plan.approvalHash,
      sourceVerdictPath: 'research/quality/verdict-wave-0.json',
      sourceVerdictHash: hashCanonicalValue(fixture.verdict),
      taskRequests: {
        T2: fixture.verdict.correctionRequests,
        T3: fixture.verdict.correctionRequests,
      },
    })
    assert.equal(fs.existsSync(fixture.inputPath), true)
    assert.equal(fs.existsSync(path.join(fixture.workspace, 'research-package.md')), true)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('archives the second wave without changing immutable first-wave artifacts', () => {
  const fixture = createWorkspace({ taskIds: ['T2'] })
  try {
    const firstRun = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)
    assert.equal(firstRun.status, 0, firstRun.stderr)
    const immutableWaveZero = {
      verdict: fs.readFileSync(
        path.join(fixture.workspace, 'research', 'quality', 'verdict-wave-0.json'),
      ),
      report: fs.readFileSync(
        path.join(fixture.workspace, 'research', 'reports', 'report-wave-0.md'),
      ),
      review: fs.readFileSync(
        path.join(
          fixture.workspace,
          'research',
          'quality',
          'deterministic-review-wave-0.json',
        ),
      ),
      plan: fs.readFileSync(
        path.join(fixture.workspace, 'research', 'plans', 'plan-wave-0.md'),
      ),
    }
    const waveOnePlan = fs.readFileSync(
      path.join(fixture.workspace, 'research', 'plan.md'),
      'utf8',
    )

    const secondVerdict = createVerdict(1, ['T1'])
    const secondInput = path.join(
      fixture.workspace,
      'research',
      'quality',
      'current-verdict-wave-1.json',
    )
    const secondOutput = path.join(
      fixture.workspace,
      'research',
      'correction-context-wave-2.json',
    )
    writeJson(secondInput, secondVerdict)
    fs.writeFileSync(path.join(fixture.workspace, 'research-package.md'), '# Wave one report\n')
    writeJson(
      path.join(fixture.workspace, 'research', 'quality', 'deterministic-verdict.json'),
      { schemaVersion: 1, decision: 'REVISE', summary: 'Wave one still needs work.' },
    )

    const secondRun = runScript(fixture.workspace, secondInput, secondOutput)
    assert.equal(secondRun.status, 0, secondRun.stderr)

    assert.deepEqual(
      fs.readFileSync(
        path.join(fixture.workspace, 'research', 'quality', 'verdict-wave-0.json'),
      ),
      immutableWaveZero.verdict,
    )
    assert.deepEqual(
      fs.readFileSync(
        path.join(fixture.workspace, 'research', 'reports', 'report-wave-0.md'),
      ),
      immutableWaveZero.report,
    )
    assert.deepEqual(
      fs.readFileSync(
        path.join(
          fixture.workspace,
          'research',
          'quality',
          'deterministic-review-wave-0.json',
        ),
      ),
      immutableWaveZero.review,
    )
    assert.deepEqual(
      fs.readFileSync(
        path.join(fixture.workspace, 'research', 'plans', 'plan-wave-0.md'),
      ),
      immutableWaveZero.plan,
    )
    assert.equal(
      fs.readFileSync(
        path.join(fixture.workspace, 'research', 'plans', 'plan-wave-1.md'),
        'utf8',
      ),
      waveOnePlan,
    )
    assert.match(
      fs.readFileSync(path.join(fixture.workspace, 'research', 'plan.md'), 'utf8'),
      /research\/evidence\/wave-2\/T1\.json/,
    )
    assert.deepEqual(readJson(secondOutput), {
      schemaVersion: 1,
      wave: 2,
      approvedPlanHash: fixture.plan.approvalHash,
      sourceVerdictPath: 'research/quality/verdict-wave-1.json',
      sourceVerdictHash: hashCanonicalValue(secondVerdict),
      taskRequests: { T1: secondVerdict.correctionRequests },
    })
    assert.equal(fs.existsSync(secondInput), true)
    assert.equal(fs.existsSync(path.join(fixture.workspace, 'research-package.md')), true)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('rejects attempts to change an existing immutable wave archive', () => {
  const fixture = createWorkspace({ taskIds: ['T2'] })
  try {
    const firstRun = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)
    assert.equal(firstRun.status, 0, firstRun.stderr)
    const archivePath = path.join(
      fixture.workspace,
      'research',
      'reports',
      'report-wave-0.md',
    )
    const archivedReport = fs.readFileSync(archivePath)
    const correctionPlan = fs.readFileSync(
      path.join(fixture.workspace, 'research', 'plan.md'),
    )

    writeJson(fixture.inputPath, fixture.verdict)
    fs.writeFileSync(path.join(fixture.workspace, 'research-package.md'), '# Replaced report\n')
    const repeatedRun = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.notEqual(repeatedRun.status, 0)
    assert.match(repeatedRun.stderr, /Immutable correction artifact changed: report-wave-0\.md/)
    assert.deepEqual(fs.readFileSync(archivePath), archivedReport)
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.workspace, 'research', 'plan.md')),
      correctionPlan,
    )
    assert.equal(fs.existsSync(fixture.inputPath), true)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('rejects unknown task targets before changing current artifacts', () => {
  const fixture = createWorkspace({ taskIds: ['T99'] })
  try {
    const originalPlan = fs.readFileSync(path.join(fixture.workspace, 'research', 'plan.md'))
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /Correction references unknown task 'T99'/)
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.workspace, 'research', 'plan.md')),
      originalPlan,
    )
    assert.equal(fs.existsSync(fixture.outputPath), false)
    assert.equal(fs.existsSync(fixture.inputPath), true)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('rejects a third correction wave before changing current artifacts', () => {
  const fixture = createWorkspace({ correctionWave: 2, taskIds: ['T1'] })
  try {
    const originalPlan = fs.readFileSync(path.join(fixture.workspace, 'research', 'plan.md'))
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /Only correction waves 1 and 2 may be materialized/)
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.workspace, 'research', 'plan.md')),
      originalPlan,
    )
    assert.equal(fs.existsSync(fixture.outputPath), false)
    assert.equal(fs.existsSync(fixture.inputPath), true)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('rejects a correction wave before dispatch when its critical path cannot fit', () => {
  const fixture = createWorkspace({
    taskIds: ['T2', 'T3'],
    remainingMs: 2 * 60_000,
  })
  try {
    const originalPlan = fs.readFileSync(
      path.join(fixture.workspace, 'research', 'plan.md'),
    )
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.equal(run.status, 69)
    assert.match(run.stderr, /Insufficient remaining execution budget/)
    assert.match(run.stderr, /No correction tasks were started/)
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.workspace, 'research', 'plan.md')),
      originalPlan,
    )
    assert.equal(fs.existsSync(fixture.outputPath), false)
    assert.equal(
      fs.existsSync(
        path.join(fixture.workspace, 'research', 'quality', 'verdict-wave-0.json'),
      ),
      false,
    )
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('refuses the failed-run correction wave using observed durations', () => {
  const fixture = createWorkspace({ remainingMs: 9 * 60_000, timings: 'failed-run' })
  try {
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.equal(run.status, 69)
    assert.match(run.stderr, /837 seconds required/)
    assert.match(run.stderr, /No correction tasks were started/)
    assert.equal(fs.existsSync(fixture.outputPath), false)
    assert.equal(fs.existsSync(
      path.join(fixture.workspace, 'research', 'quality', 'verdict-wave-0.json'),
    ), false)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('uses conservative fallbacks when timing logs are missing', () => {
  const fixture = createWorkspace({ timings: 'missing' })
  try {
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.equal(run.status, 69)
    assert.match(run.stderr, /720 seconds required/)
    assert.equal(fs.existsSync(fixture.outputPath), false)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('ignores malformed timing logs and uses conservative fallbacks', () => {
  const fixture = createWorkspace({ timings: 'malformed' })
  try {
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.equal(run.status, 69)
    assert.match(run.stderr, /720 seconds required/)
    assert.equal(fs.existsSync(fixture.outputPath), false)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('keeps the restructure-only research estimate at thirty seconds', () => {
  const fixture = createWorkspace({ remainingMs: 250_000 })
  try {
    fixture.verdict.correctionRequests[0]!.type = 'restructure_packet'
    writeJson(fixture.inputPath, fixture.verdict)
    fs.rmSync(path.join(fixture.workspace, 'research', 'evidence', 'wave-0'), {
      recursive: true,
      force: true,
    })

    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.equal(run.status, 0, run.stderr)
    assert.equal(fs.existsSync(fixture.outputPath), true)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('rejects a symbolic-link transform input without following it', () => {
  const fixture = createWorkspace({ taskIds: ['T1'] })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-correction-wave-outside-'))
  try {
    const outsideVerdict = path.join(outside, 'verdict.json')
    writeJson(outsideVerdict, fixture.verdict)
    fs.rmSync(fixture.inputPath)
    fs.symlinkSync(outsideVerdict, fixture.inputPath)

    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /quality verdict must be a regular file/)
    assert.equal(fs.existsSync(fixture.outputPath), false)
    assert.deepEqual(readJson(outsideVerdict), fixture.verdict)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('rejects a symbolic-link transform output before archiving or changing the plan', () => {
  const fixture = createWorkspace({ taskIds: ['T1'] })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-correction-output-'))
  try {
    const outsideContext = path.join(outside, 'context.json')
    fs.writeFileSync(outsideContext, '{}\n')
    fs.symlinkSync(outsideContext, fixture.outputPath)
    const originalPlan = fs.readFileSync(path.join(fixture.workspace, 'research', 'plan.md'))

    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /Correction output must be a regular file/)
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.workspace, 'research', 'plan.md')),
      originalPlan,
    )
    assert.equal(fs.existsSync(
      path.join(fixture.workspace, 'research', 'quality', 'verdict-wave-0.json'),
    ), false)
    assert.equal(fs.readFileSync(outsideContext, 'utf8'), '{}\n')
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})
