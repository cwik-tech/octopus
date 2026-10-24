import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  parsePlan,
  getReadyTasks,
  isSprintComplete,
  areAllSprintsComplete,
  updateTaskStatus,
  autoSkipDependents,
  validatePlanFormat,
} from '../../parsers/plan-parser.js'

function withPlan(content: string, fn: (planPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-parser-test-'))
  const planPath = path.join(dir, 'plan.md')
  fs.writeFileSync(planPath, content)
  try {
    fn(planPath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function concurrentPlan(taskCount: number): string {
  return [
    '# Plan: Concurrent status updates',
    '**Status:** executing',
    '',
    '### S1: Parallel work',
    ...Array.from({ length: taskCount }, (_, index) => [
      `#### T${index + 1}: Task ${index + 1}`,
      `- **Agent:** agent-${index + 1}`,
      '- **Status:** pending',
      '- **Validate:** false',
      '- **Depends on:** none',
      '- **Gate:** false',
      `- **Result file:** result-${index + 1}.md`,
      '',
    ].join('\n')),
    '<!-- complete-plan-tail -->',
    '',
  ].join('\n')
}

async function waitForFiles(paths: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (paths.every((filepath) => fs.existsSync(filepath))) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Concurrent plan updater processes did not reach the barrier.')
}

function childExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, stderr }))
  })
}

test('getReadyTasks returns only unblocked pending tasks', () => {
  withPlan(`
# Plan: Sample
**Status:** draft

### S1: Sprint
#### T1: First task
- **Agent:** alpha
- **Status:** completed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** one.md

#### T2: Second task
- **Agent:** beta
- **Status:** pending
- **Validate:** false
- **Depends on:** T1
- **Gate:** false
- **Result file:** two.md

#### T3: Third task
- **Agent:** gamma
- **Status:** pending
- **Validate:** false
- **Depends on:** T2
- **Gate:** false
- **Result file:** three.md
`, (planPath) => {
    const plan = parsePlan(planPath)
    assert.ok(plan)
    assert.deepEqual(getReadyTasks(plan!).map((task) => task.id), ['T2'])
  })
})

test('plan validation rejects private-runtime and traversal result paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-result-path-'))
  try {
    const planPath = path.join(dir, 'plan.md')
    fs.writeFileSync(planPath, concurrentPlan(1))
    assert.equal(validatePlanFormat(planPath).valid, true)

    fs.writeFileSync(
      planPath,
      concurrentPlan(1).replace(
        'result-1.md',
        '.runtime/workflow-state.json',
      ),
    )
    assert.match(
      validatePlanFormat(planPath).errors.join('\n'),
      /safe assignment-relative path outside '\.runtime'/,
    )

    fs.writeFileSync(
      planPath,
      concurrentPlan(1).replace('result-1.md', '../external.md'),
    )
    assert.equal(validatePlanFormat(planPath).valid, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('autoSkipDependents skips the full transitive dependent closure', () => {
  withPlan(`
# Plan: Sample
**Status:** executing

### S1: Sprint
#### T1: Failed source task
- **Agent:** alpha
- **Status:** failed
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** one.md

#### T2: Direct dependent
- **Agent:** beta
- **Status:** pending
- **Validate:** false
- **Depends on:** T1
- **Gate:** false
- **Result file:** two.md

#### T3: Transitive dependent
- **Agent:** gamma
- **Status:** pending
- **Validate:** false
- **Depends on:** T2
- **Gate:** false
- **Result file:** three.md
`, (planPath) => {
    assert.deepEqual(autoSkipDependents(planPath, 'T1'), ['T2', 'T3'])
    const plan = parsePlan(planPath)
    assert.equal(plan?.tasks.get('T2')?.status, 'skipped')
    assert.equal(plan?.tasks.get('T3')?.status, 'skipped')
  })
})

test('sprint completion respects validation requirements', () => {
  withPlan(`
# Plan: Sample
**Status:** draft

### S1: Sprint
#### T1: Gate task
- **Agent:** alpha
- **Status:** completed
- **Validate:** true
- **Depends on:** none
- **Gate:** true
- **Result file:** one.md
`, (planPath) => {
    let plan = parsePlan(planPath)
    assert.ok(plan)
    assert.equal(isSprintComplete(plan!, 'S1'), false)
    updateTaskStatus(planPath, 'T1', 'validated')
    plan = parsePlan(planPath)
    assert.ok(plan)
    assert.equal(isSprintComplete(plan!, 'S1'), true)
    assert.equal(areAllSprintsComplete(plan!), true)
  })
})

test('updateTaskStatus atomically replaces the plan and rejects symlink targets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-parser-atomic-'))
  try {
    const planPath = path.join(dir, 'plan.md')
    fs.writeFileSync(planPath, concurrentPlan(1), { mode: 0o640 })
    const before = fs.statSync(planPath)

    assert.equal(updateTaskStatus(planPath, 'T1', 'completed'), true)
    const after = fs.statSync(planPath)
    assert.notEqual(after.ino, before.ino, 'atomic rename should replace the inode')
    assert.equal(after.mode & 0o777, before.mode & 0o777)
    assert.equal(parsePlan(planPath)?.tasks.get('T1')?.status, 'completed')

    fs.writeFileSync(
      `${planPath}.status.lock`,
      JSON.stringify({
        pid: 2_147_483_647,
        nonce: 'dead-writer',
        createdAt: '2000-01-01T00:00:00.000Z',
      }),
    )
    assert.equal(updateTaskStatus(planPath, 'T1', 'validated'), true)
    assert.equal(parsePlan(planPath)?.tasks.get('T1')?.status, 'validated')
    assert.equal(
      updateTaskStatus(planPath, 'T1', 'failed', 'pending'),
      false,
    )
    assert.equal(parsePlan(planPath)?.tasks.get('T1')?.status, 'validated')

    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.tmp') || name.includes('.lock')),
      [],
    )

    const externalPath = path.join(dir, 'external.md')
    const symlinkPath = path.join(dir, 'linked-plan.md')
    fs.writeFileSync(externalPath, concurrentPlan(1))
    fs.symlinkSync(externalPath, symlinkPath)
    const externalBefore = fs.readFileSync(externalPath, 'utf8')
    assert.equal(updateTaskStatus(symlinkPath, 'T1', 'failed'), false)
    assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true)
    assert.equal(fs.readFileSync(externalPath, 'utf8'), externalBefore)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('updateTaskStatus removes abandoned reclaim guards', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-parser-reclaim-'))
  try {
    const planPath = path.join(dir, 'plan.md')
    const reclaimPath = `${planPath}.status.lock.reclaim`
    fs.writeFileSync(planPath, concurrentPlan(1))
    fs.mkdirSync(reclaimPath)
    const staleTime = new Date('2000-01-01T00:00:00.000Z')
    fs.utimesSync(reclaimPath, staleTime, staleTime)

    assert.equal(updateTaskStatus(planPath, 'T1', 'completed'), true)
    assert.equal(fs.existsSync(reclaimPath), false)

    fs.mkdirSync(reclaimPath)
    fs.writeFileSync(
      path.join(reclaimPath, 'owner.json'),
      `${JSON.stringify({
        pid: 2_147_483_647,
        nonce: 'killed-plan-reclaimer',
        createdAt: '2026-07-13T12:00:00.000Z',
      })}\n`,
    )
    assert.equal(updateTaskStatus(planPath, 'T1', 'validated'), true)
    assert.equal(parsePlan(planPath)?.tasks.get('T1')?.status, 'validated')

    fs.writeFileSync(
      reclaimPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        nonce: 'killed-atomic-plan-reclaimer',
        createdAt: '2026-07-13T12:00:00.000Z',
      })}\n`,
    )
    assert.equal(updateTaskStatus(planPath, 'T1', 'failed'), true)
    assert.equal(fs.existsSync(reclaimPath), false)
    assert.deepEqual(
      fs.readdirSync(dir)
        .filter((name) => name.includes('.reclaim') || name.includes('.orphan-')),
      [],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a paused unpublished plan lock candidate cannot block an atomic winner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-parser-candidate-'))
  try {
    const planPath = path.join(dir, 'plan.md')
    const lockPath = `${planPath}.status.lock`
    const candidatePath = `${lockPath}.candidate-${process.pid}-paused-owner`
    fs.writeFileSync(planPath, concurrentPlan(1))
    fs.writeFileSync(candidatePath, `${JSON.stringify({
      pid: process.pid,
      nonce: 'paused-owner',
      createdAt: '2026-07-13T12:00:00.000Z',
    })}\n`)

    assert.equal(updateTaskStatus(planPath, 'T1', 'completed'), true)
    assert.equal(parsePlan(planPath)?.tasks.get('T1')?.status, 'completed')
    assert.equal(fs.existsSync(lockPath), false)
    assert.equal(fs.existsSync(candidatePath), true)
    fs.unlinkSync(candidatePath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parallel claimants allow exactly one pending to in_progress transition', {
  timeout: 10_000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-parser-claim-'))
  try {
    const planPath = path.join(dir, 'plan.md')
    const releasePath = path.join(dir, 'release')
    const moduleUrl = pathToFileURL(
      path.resolve(process.cwd(), 'parsers', 'plan-parser.ts'),
    ).href
    fs.writeFileSync(planPath, concurrentPlan(1))
    const childSource = [
      "import fs from 'node:fs'",
      "fs.writeFileSync(process.env.READY_PATH, 'ready')",
      'const wait = new Int32Array(new SharedArrayBuffer(4))',
      'while (!fs.existsSync(process.env.RELEASE_PATH)) Atomics.wait(wait, 0, 0, 5)',
      'const { updateTaskStatus } = await import(process.env.PLAN_PARSER_URL)',
      "const claimed = updateTaskStatus(process.env.PLAN_PATH, 'T1', 'in_progress', 'pending')",
      'process.exitCode = claimed ? 0 : 3',
    ].join(';\n')
    const readyPaths = [path.join(dir, 'ready-1'), path.join(dir, 'ready-2')]
    const children = readyPaths.map((readyPath) => spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childSource],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PLAN_PATH: planPath,
          READY_PATH: readyPath,
          RELEASE_PATH: releasePath,
          PLAN_PARSER_URL: moduleUrl,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    ))
    const exits = children.map(childExit)

    await waitForFiles(readyPaths)
    fs.writeFileSync(releasePath, 'go')
    const results = await Promise.all(exits)

    assert.deepEqual(
      results.map((result) => result.code).sort(),
      [0, 3],
      results.map((result) => result.stderr).filter(Boolean).join('\n'),
    )
    assert.equal(parsePlan(planPath)?.tasks.get('T1')?.status, 'in_progress')
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.tmp') || name.includes('.lock')),
      [],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parallel stale-lock reclaimers serialize status updates without lost writes', { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-parser-concurrent-'))
  const taskCount = 12
  try {
    const planPath = path.join(dir, 'plan.md')
    const releasePath = path.join(dir, 'release')
    fs.writeFileSync(planPath, concurrentPlan(taskCount))
    fs.writeFileSync(
      `${planPath}.status.lock`,
      JSON.stringify({
        pid: 2_147_483_647,
        nonce: 'dead-shared-writer',
        createdAt: '2000-01-01T00:00:00.000Z',
      }),
    )
    const pausedCandidatePath = `${planPath}.status.lock.candidate-${process.pid}-paused-concurrent-owner`
    fs.writeFileSync(pausedCandidatePath, JSON.stringify({
      pid: process.pid,
      nonce: 'paused-concurrent-owner',
      createdAt: '2026-07-13T12:00:00.000Z',
    }))
    const moduleUrl = pathToFileURL(
      path.resolve(process.cwd(), 'parsers', 'plan-parser.ts'),
    ).href
    const childSource = [
      "import fs from 'node:fs'",
      "fs.writeFileSync(process.env.READY_PATH, 'ready')",
      'const wait = new Int32Array(new SharedArrayBuffer(4))',
      'while (!fs.existsSync(process.env.RELEASE_PATH)) Atomics.wait(wait, 0, 0, 5)',
      'const { updateTaskStatus } = await import(process.env.PLAN_PARSER_URL)',
      "const updated = updateTaskStatus(process.env.PLAN_PATH, process.env.TASK_ID, 'completed')",
      'if (!updated) process.exitCode = 2',
    ].join(';\n')
    const readyPaths = Array.from(
      { length: taskCount },
      (_, index) => path.join(dir, `ready-${index + 1}`),
    )
    const children = readyPaths.map((readyPath, index) => spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childSource],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PLAN_PATH: planPath,
          TASK_ID: `T${index + 1}`,
          READY_PATH: readyPath,
          RELEASE_PATH: releasePath,
          PLAN_PARSER_URL: moduleUrl,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    ))
    const exits = children.map(childExit)

    await waitForFiles(readyPaths)
    fs.writeFileSync(releasePath, 'go')
    const results = await Promise.all(exits)
    assert.deepEqual(
      results.map((result) => result.code),
      Array(taskCount).fill(0),
      results.map((result) => result.stderr).filter(Boolean).join('\n'),
    )
    assert.equal(fs.existsSync(pausedCandidatePath), true)
    fs.unlinkSync(pausedCandidatePath)

    const plan = parsePlan(planPath)
    assert.ok(plan)
    assert.equal(plan!.tasks.size, taskCount)
    for (let index = 1; index <= taskCount; index++) {
      assert.equal(plan!.tasks.get(`T${index}`)?.status, 'completed')
    }
    assert.match(fs.readFileSync(planPath, 'utf8'), /<!-- complete-plan-tail -->/)
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.tmp') || name.includes('.lock')),
      [],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
