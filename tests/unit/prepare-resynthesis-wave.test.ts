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
  'prepare-resynthesis-wave.mjs',
)

function createWorkspace(options: {
  remainingMs?: number
  timings?: 'fast' | 'missing' | 'malformed' | 'failed-run'
} = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-resynthesis-wave-'))
  const inputPath = path.join(workspace, 'research', 'quality', 'current-verdict.json')
  const outputPath = path.join(workspace, 'research', 'corrections', 'current.json')
  const plan = {
    schemaVersion: 1,
    planId: 'approved-plan-one',
    maxDurationMinutes: 20,
    approvalHash: 'approved-plan-hash-one',
  }
  const deterministic = {
    schemaVersion: 1,
    verdictId: 'deterministic-zero',
    correctionWave: 0,
    decision: 'APPROVE',
    findings: [{
      code: 'unresolved_question',
      severity: 'warning',
      message: 'A minor disclosed uncertainty remains.',
      taskIds: ['T1'],
      sectionIds: ['section-market'],
      claimIds: [],
      sourceIds: [],
    }],
    correctionRequests: [],
    reviewedAt: '2026-07-18T12:00:00.000Z',
  }
  const verdict = {
    schemaVersion: 1,
    verdictId: 'authoritative-zero',
    correctionWave: 0,
    decision: 'REVISE',
    correctionRoute: 'synthesis',
    findings: [{
      code: 'report_evidence_mismatch',
      severity: 'blocking',
      message: 'The report omits a material evidence-backed limitation.',
      taskIds: ['T1'],
      sectionIds: ['section-market'],
      claimIds: [],
      sourceIds: [],
    }],
    correctionRequests: [{
      schemaVersion: 1,
      id: 'rewrite-market-section',
      type: 'resynthesize',
      claimIds: [],
      taskIds: ['T1'],
      sectionIds: ['section-market'],
      acceptanceCriteria: ['State the limitation in the market section.'],
      impactScope: 'local',
    }],
    reviewedAt: '2026-07-18T12:01:00.000Z',
  }

  writeJson(path.join(workspace, 'research', 'approved-plan.json'), plan)
  writeJson(path.join(workspace, 'research', 'runtime-limits.json'), {
    schemaVersion: 1,
    planId: plan.planId,
    maxDurationMinutes: plan.maxDurationMinutes,
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    deadlineAt: new Date(Date.now() + (options.remainingMs ?? 10 * 60_000)).toISOString(),
  })
  writeJson(path.join(workspace, 'research', 'quality', 'deterministic-verdict.json'), deterministic)
  writeJson(inputPath, verdict)
  fs.writeFileSync(path.join(workspace, 'research-package.md'), '# Original report\n')
  writeTimingFixtures(workspace, options.timings ?? 'fast')
  return { deterministic, inputPath, outputPath, plan, verdict, workspace }
}

function writeTimingFixtures(
  workspace: string,
  timings: 'fast' | 'missing' | 'malformed' | 'failed-run',
): void {
  if (timings === 'missing') return
  const agentLog = path.join(workspace, 'logs', 'agent-runs.jsonl')
  if (timings === 'malformed') {
    writeText(agentLog, '{"event":"end","duration_ms":\nnot-json\n')
    return
  }
  const synthesisMs = timings === 'failed-run' ? 219_499 : 40_000
  const criticMs = timings === 'failed-run' ? 86_809 : 60_000
  const timestamp = '2026-07-19T04:44:07.000Z'
  writeText(agentLog, [
    JSON.stringify(completedAgentRun('research-synthesizer', timestamp, synthesisMs)),
    JSON.stringify(completedAgentRun('evidence-critic', timestamp, criticMs)),
    '',
  ].join('\n'))
}

function completedAgentRun(
  agentName: string,
  timestamp: string,
  durationMs: number,
): Record<string, unknown> {
  return {
    timestamp,
    event: 'end',
    agent_name: agentName,
    status: 'completed',
    duration_ms: durationMs,
  }
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
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

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
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

test('materializes a synthesis-only wave without scheduling research', () => {
  const fixture = createWorkspace()
  try {
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)
    assert.equal(run.status, 0, run.stderr)

    const context = readJson(fixture.outputPath)
    assert.deepEqual(context, {
      schemaVersion: 1,
      wave: 1,
      approvedPlanHash: fixture.plan.approvalHash,
      sourceVerdictPath: 'research/quality/verdict-wave-0.json',
      sourceVerdictHash: hashCanonicalValue(fixture.verdict),
      taskRequests: {},
    })
    assert.equal(fs.existsSync(fixture.inputPath), false)
    assert.equal(fs.existsSync(path.join(fixture.workspace, 'research-package.md')), false)
    assert.equal(
      fs.readFileSync(
        path.join(fixture.workspace, 'research', 'reports', 'report-wave-0.md'),
        'utf8',
      ),
      '# Original report\n',
    )
    const nextDeterministic = readJson(
      path.join(fixture.workspace, 'research', 'quality', 'deterministic-verdict.json'),
    )
    assert.equal(nextDeterministic.correctionWave, 1)
    assert.equal(nextDeterministic.decision, 'APPROVE')
    assert.deepEqual(nextDeterministic.findings, fixture.deterministic.findings)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('rejects resynthesis before writing when the remaining deadline cannot fit the safe path', () => {
  const fixture = createWorkspace({ remainingMs: 209_000 })
  try {
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)
    assert.equal(run.status, 69)
    assert.match(run.stderr, /Insufficient remaining execution budget for safe resynthesis/)
    assert.equal(fs.existsSync(fixture.outputPath), false)
    assert.equal(fs.existsSync(
      path.join(fixture.workspace, 'research', 'quality', 'verdict-wave-0.json'),
    ), false)
    assert.equal(fs.existsSync(fixture.inputPath), true)
    assert.equal(fs.existsSync(path.join(fixture.workspace, 'research-package.md')), true)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('refuses resynthesis using the latest observed synthesis duration', () => {
  const fixture = createWorkspace({ remainingMs: 390_000, timings: 'failed-run' })
  try {
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.equal(run.status, 69)
    assert.match(run.stderr, /395 seconds required/)
    assert.equal(fs.existsSync(fixture.outputPath), false)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('uses conservative resynthesis fallbacks when timing logs are missing', () => {
  const fixture = createWorkspace({ remainingMs: 6 * 60_000, timings: 'missing' })
  try {
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.equal(run.status, 69)
    assert.match(run.stderr, /420 seconds required/)
    assert.equal(fs.existsSync(fixture.outputPath), false)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('ignores malformed resynthesis timing logs and uses fallbacks', () => {
  const fixture = createWorkspace({ remainingMs: 6 * 60_000, timings: 'malformed' })
  try {
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.equal(run.status, 69)
    assert.match(run.stderr, /420 seconds required/)
    assert.equal(fs.existsSync(fixture.outputPath), false)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('rejects mixed correction requests on the synthesis-only route', () => {
  const fixture = createWorkspace()
  try {
    writeJson(fixture.inputPath, {
      ...fixture.verdict,
      correctionRequests: [{
        ...fixture.verdict.correctionRequests[0],
        type: 'new_research',
      }],
    })
    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /resynthesize requests only/)
    assert.equal(fs.existsSync(fixture.outputPath), false)
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
  }
})

test('rejects a symbolic-link output before changing report or verdict artifacts', () => {
  const fixture = createWorkspace()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-resynthesis-output-'))
  try {
    const outsideContext = path.join(outside, 'context.json')
    fs.writeFileSync(outsideContext, '{}\n')
    fs.mkdirSync(path.dirname(fixture.outputPath), { recursive: true })
    fs.symlinkSync(outsideContext, fixture.outputPath)

    const run = runScript(fixture.workspace, fixture.inputPath, fixture.outputPath)

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /Resynthesis output must be a regular file/)
    assert.equal(fs.existsSync(fixture.inputPath), true)
    assert.equal(fs.existsSync(path.join(fixture.workspace, 'research-package.md')), true)
    assert.equal(fs.existsSync(
      path.join(fixture.workspace, 'research', 'quality', 'verdict-wave-0.json'),
    ), false)
    assert.equal(fs.readFileSync(outsideContext, 'utf8'), '{}\n')
  } finally {
    fs.rmSync(fixture.workspace, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})
