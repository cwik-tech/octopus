import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

/**
 * Guards for the delegated-autostart recovery path.
 *
 * A delegated child is told to reply NOOP while runtime autostart owns the
 * stage. When autostart declined without saying so, the host obeyed that
 * instruction for a stage nobody ran: the child produced no artifact, and the
 * parent reported a host-provider failure that had not happened. These assert
 * the two invariants that made the silence possible — the skip must be
 * recorded, and ownership must be a fact rather than an environment variable.
 *
 * The real runtime now runs these paths in
 * `tests/integration/team-runtime-engine-stage-autostart.test.ts` (the
 * runtime-owned stage protocol), `team-runtime-stage-autostart-skip.test.ts`
 * (the skips the entrypoint can reach) and
 * `team-runtime-autostart-destination-ownership.test.ts`. The parent's reading
 * of these events is in `tests/integration/agent-runner.test.ts`, and the full
 * journey against a real provider in
 * `tests/e2e/run-live-delegated-autostart-recovery.sh`.
 *
 * The checks below stay as source checks: some guard branches the entrypoint
 * cannot reach (four of the skip reasons, and when stage tools are published),
 * and the rest are guards kept alongside the tests above. The runtime-owned
 * stage protocol moved to `team-runtime/stage-autostart.ts`, the discussion
 * lead call and pass loop to `team-runtime/discussion-autostart.ts`, and the
 * recovery prelude's decisions to `team-runtime/stage-recovery.ts`, so the
 * checks on that code read those modules too. The session start's checkpoint
 * adoption decisions moved to `team-runtime/checkpoint-adoption.ts`, and the
 * boot's decisions to `team-runtime/team-boot.ts`, so the one-read-site check
 * reads them too. Level tool arming moved to `team-runtime/level-tools.ts`, so
 * the publication check and the one-read-site check read it as well. The host
 * turn lifecycle moved to `team-runtime/host-turn-lifecycle.ts`, so the
 * one-read-site check reads it too. The two teardown routes moved to
 * `team-runtime/runtime-teardown.ts`, so the one-read-site check reads it too.
 */

const INDEX_PATH = path.join(process.cwd(), 'team-runtime', 'index.ts')
const STAGE_AUTOSTART_PATH = path.join(process.cwd(), 'team-runtime', 'stage-autostart.ts')
const DISCUSSION_AUTOSTART_PATH = path.join(process.cwd(), 'team-runtime', 'discussion-autostart.ts')
const STAGE_RECOVERY_PATH = path.join(process.cwd(), 'team-runtime', 'stage-recovery.ts')
const CHECKPOINT_ADOPTION_PATH = path.join(process.cwd(), 'team-runtime', 'checkpoint-adoption.ts')
const TEAM_BOOT_PATH = path.join(process.cwd(), 'team-runtime', 'team-boot.ts')
const LEVEL_TOOLS_PATH = path.join(process.cwd(), 'team-runtime', 'level-tools.ts')
const HOST_TURN_LIFECYCLE_PATH = path.join(process.cwd(), 'team-runtime', 'host-turn-lifecycle.ts')
const RUNTIME_TEARDOWN_PATH = path.join(process.cwd(), 'team-runtime', 'runtime-teardown.ts')
const PROMPT_BUILDER_PATH = path.join(process.cwd(), 'team-runtime', 'prompt-builder.ts')

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('stage autostart never declines silently', () => {
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  const autostart = sliceBetween(
    source,
    'async function startStageAutostart',
    '// ── Lifecycle callbacks',
  )

  const bareRefusals = autostart.match(/return false;/gu) ?? []
  assert.deepEqual(
    bareRefusals,
    [],
    'every autostart refusal must go through logStageAutostartSkipped so the ' +
      'parent can name the cause instead of blaming the host provider',
  )
  assert.match(autostart, /logStageAutostartSkipped\("no_team_config"\)/u)
  assert.match(autostart, /logStageAutostartSkipped\("no_coordinator"\)/u)
  assert.match(autostart, /logStageAutostartSkipped\("stage_not_autostartable"\)/u)
  assert.match(autostart, /logStageAutostartSkipped\("missing_tool_invokers"/u)

  // The runtime-owned stage protocol moved out of startStageAutostart.
  const moved = fs.readFileSync(STAGE_AUTOSTART_PATH, 'utf8')
  assert.deepEqual(
    moved.match(/return false;/gu) ?? [],
    [],
    'the moved stage autostart must not decline without logging why',
  )
  // The discussion lead call and the discussion pass loop, with its failure
  // arm, moved out of startStageAutostart too.
  const movedDiscussion = fs.readFileSync(DISCUSSION_AUTOSTART_PATH, 'utf8')
  assert.deepEqual(
    movedDiscussion.match(/return false;/gu) ?? [],
    [],
    'the moved discussion autostart must not decline without logging why',
  )
  // The recovery prelude's decisions moved to a pure module.
  const movedRecovery = fs.readFileSync(STAGE_RECOVERY_PATH, 'utf8')
  assert.deepEqual(
    movedRecovery.match(/return false;/gu) ?? [],
    [],
    'the recovery decisions must not decline without logging why',
  )
})

test('the skipped-autostart event carries the tools that were missing', () => {
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  const logger = sliceBetween(
    source,
    'function logStageAutostartSkipped',
    'async function startActiveLevel',
  )

  assert.match(logger, /event: "runtime\.stage_autostart\.skipped"/u)
  assert.match(logger, /reason,/u)
  assert.match(logger, /missing_tools:/u)
  assert.match(logger, /registered_tools: ctx\.currentRegisteredTools/u)
})

// tests/integration/team-runtime-autostart-destination-ownership.test.ts now
// runs this contract; the source check stays with the other static checks.
test('stage ownership is recorded for the level that remains active after autostart', () => {
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  const wrapper = sliceBetween(
    source,
    'async function startActiveLevel',
    'async function startStageAutostart',
  )

  assert.match(wrapper, /const startingLevelId = getCurrentLevel\(\)\?\.id/u)
  assert.match(wrapper, /const started = await startStageAutostart\(extCtx\)/u)
  assert.match(wrapper, /resolveRuntimeAutostartOwnership/u)
  assert.match(wrapper, /activeLevelId: getCurrentLevel\(\)\?\.id/u)
})

test('the host NOOP prompt is gated on ownership and never silences a recovery attempt', () => {
  const source = fs.readFileSync(PROMPT_BUILDER_PATH, 'utf8')
  const gate = sliceBetween(
    source,
    'function runtimeOwnsStageExecution',
    'export function resolveHostWorkflowPrompt',
  )

  assert.match(gate, /TEAM_RUNTIME_RECOVERY === '1'\) return false/u)
  assert.match(gate, /return ctx\.delegatedAutostartOwnsStage/u)
})

test('stage tools are published to the runtime context as they register', () => {
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  // index.ts's publication port assigns the collections it is handed.
  const publication = sliceBetween(
    source,
    'publishCurrentTools: (registeredTools, toolInvokers) => {',
    'engineContext: () =>',
  )

  // Publishing only after every registration succeeded meant one unrelated
  // failure left autostart looking at the previous level's invokers.
  assert.match(publication, /ctx\.currentRegisteredTools = registeredTools;/u)
  assert.match(publication, /ctx\.currentToolInvokers = toolInvokers;/u)

  // Arming moved to level-tools.ts. It hands the port its live collections
  // before it defines the helper every governed registration goes through,
  // and registers nothing before that.
  const moved = fs.readFileSync(LEVEL_TOOLS_PATH, 'utf8')
  const registration = sliceBetween(
    moved,
    'export function armLevelTools',
    'function registerGovernedTool',
  )
  assert.match(registration, /publishCurrentTools\(registeredTools, toolInvokers\)/u)
  assert.doesNotMatch(registration, /registerTool\(/u)
})

test('fault injection can force an autostart skip so recovery is testable', () => {
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  const autostart = sliceBetween(
    source,
    'async function startStageAutostart',
    '// ── Lifecycle callbacks',
  )

  assert.match(
    autostart,
    /runtimeFaultInjection === "skip_stage_autostart"/u,
  )
  assert.match(autostart, /logStageAutostartSkipped\("fault_injected"\)/u)
  // One environment read site: named values remain narrow and auditable.
  assert.equal(
    (source.match(/TEAM_RUNTIME_FAULT_INJECT/gu) ?? []).length,
    1,
    'the fault-injection hook must have exactly one read site',
  )
  // The moved stage autostart takes its inputs from index.ts and reads no
  // environment, so the one read site stays the only one.
  const moved = fs.readFileSync(STAGE_AUTOSTART_PATH, 'utf8')
  assert.doesNotMatch(moved, /TEAM_RUNTIME_FAULT_INJECT/u)
  assert.doesNotMatch(moved, /process\.env/u)
  const movedDiscussion = fs.readFileSync(DISCUSSION_AUTOSTART_PATH, 'utf8')
  assert.doesNotMatch(movedDiscussion, /TEAM_RUNTIME_FAULT_INJECT/u)
  assert.doesNotMatch(movedDiscussion, /process\.env/u)
  const movedRecovery = fs.readFileSync(STAGE_RECOVERY_PATH, 'utf8')
  assert.doesNotMatch(movedRecovery, /TEAM_RUNTIME_FAULT_INJECT/u)
  assert.doesNotMatch(movedRecovery, /process\.env/u)
  // The session start's checkpoint adoption decisions moved to a pure module
  // too; index.ts reads the environment and passes the values in.
  const movedAdoption = fs.readFileSync(CHECKPOINT_ADOPTION_PATH, 'utf8')
  assert.doesNotMatch(movedAdoption, /TEAM_RUNTIME_FAULT_INJECT/u)
  assert.doesNotMatch(movedAdoption, /process\.env/u)
  // The boot's decisions moved to a pure module; index.ts reads the
  // environment and passes the values in.
  const movedBoot = fs.readFileSync(TEAM_BOOT_PATH, 'utf8')
  assert.doesNotMatch(movedBoot, /TEAM_RUNTIME_FAULT_INJECT/u)
  assert.doesNotMatch(movedBoot, /process\.env/u)
  // Level tool arming moved to its own module; index.ts reads the
  // environment and passes the values in.
  const movedLevelTools = fs.readFileSync(LEVEL_TOOLS_PATH, 'utf8')
  assert.doesNotMatch(movedLevelTools, /TEAM_RUNTIME_FAULT_INJECT/u)
  assert.doesNotMatch(movedLevelTools, /process\.env/u)
  // The host turn lifecycle moved to its own module; it takes its reads
  // through ports index.ts builds.
  const movedTurnLifecycle = fs.readFileSync(HOST_TURN_LIFECYCLE_PATH, 'utf8')
  assert.doesNotMatch(movedTurnLifecycle, /TEAM_RUNTIME_FAULT_INJECT/u)
  assert.doesNotMatch(movedTurnLifecycle, /process\.env/u)
  // The teardown routes moved to their own module; they take their reads
  // through ports index.ts builds.
  const movedTeardown = fs.readFileSync(RUNTIME_TEARDOWN_PATH, 'utf8')
  assert.doesNotMatch(movedTeardown, /TEAM_RUNTIME_FAULT_INJECT/u)
  assert.doesNotMatch(movedTeardown, /process\.env/u)
})

test('the host-admission cut points are named, and reached from the one read site', () => {
  // Recovery is decided from what reached the disk, so the two cuts a recovery
  // journey needs are the moments the admission changes what it says. They are
  // qualified by level because a run admits and dispatches an entry for every
  // level it enters: an unqualified point would always fire on the first one
  // and could never reach a handover.
  //
  // The queue does the dispatch cut and lives in another module, so the value
  // reaches it on the runtime context rather than through a second read of the
  // environment — which is what keeps the assertion above true.
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  const admission = fs.readFileSync(
    path.join(process.cwd(), 'domains', 'runtime', 'host-admission.ts'),
    'utf8',
  )

  assert.match(
    admission,
    /HOST_ADMISSION_PENDING_CRASH_POINT =\s*\n?\s*'crash_after_host_admission_pending'/u,
  )
  assert.match(
    admission,
    /HOST_ADMISSION_DISPATCH_CRASH_POINT =\s*\n?\s*'crash_after_host_admission_dispatch'/u,
  )
  assert.match(source, /ctx\.faultInjection = runtimeFaultInjection/u)
  // The claim in the title: the cut is *reached from* the one read site, so the
  // assertion is about the call that uses it rather than about the symbol
  // appearing anywhere — which an import line alone would satisfy.
  assert.match(
    source,
    /hostAdmissionCrashRequested\(\s*runtimeFaultInjection,\s*HOST_ADMISSION_PENDING_CRASH_POINT,/u,
  )
  const queue = fs.readFileSync(
    path.join(process.cwd(), 'domains', 'runtime', 'follow-up.ts'),
    'utf8',
  )
  // Both dispatch points are reached through the context, and which one applies
  // is decided by the kind of entry: a level's opening entry and the notice that
  // starts another turn on the same level are both dispatches for that level, so
  // a single point would always fire on the first and could never reach the
  // second.
  // The whole call, not the symbols: a bare symbol match is satisfied by the
  // import line alone, which is what this assertion exists to rule out.
  assert.match(
    queue,
    /hostAdmissionCrashRequested\(\s*ctx\.faultInjection,\s*entry\.kind === 'stage_entry'\s*\?\s*HOST_ADMISSION_DISPATCH_CRASH_POINT\s*:\s*HOST_NOTICE_DISPATCH_CRASH_POINT,\s*entry\.levelId,/u,
  )
  assert.match(
    admission,
    /HOST_NOTICE_DISPATCH_CRASH_POINT =\s*\n?\s*'crash_after_host_notice_dispatch'/u,
  )
  assert.equal(
    (queue.match(/TEAM_RUNTIME_FAULT_INJECT/gu) ?? []).length,
    0,
    'the queue must reach the fault-injection value through the context, not a second read',
  )
})
