import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

const INDEX_PATH = path.join(process.cwd(), 'team-runtime', 'index.ts')
const STAGE_AUTOSTART_PATH = path.join(process.cwd(), 'team-runtime', 'stage-autostart.ts')
const DISCUSSION_AUTOSTART_PATH = path.join(process.cwd(), 'team-runtime', 'discussion-autostart.ts')
const STAGE_RECOVERY_PATH = path.join(process.cwd(), 'team-runtime', 'stage-recovery.ts')
const CHECKPOINT_ADOPTION_PATH = path.join(process.cwd(), 'team-runtime', 'checkpoint-adoption.ts')
const TEAM_BOOT_PATH = path.join(process.cwd(), 'team-runtime', 'team-boot.ts')
const LEVEL_TOOLS_PATH = path.join(process.cwd(), 'team-runtime', 'level-tools.ts')
const HOST_TURN_LIFECYCLE_PATH = path.join(process.cwd(), 'team-runtime', 'host-turn-lifecycle.ts')
const RUNTIME_TEARDOWN_PATH = path.join(process.cwd(), 'team-runtime', 'runtime-teardown.ts')

test('the Pi tool-call boundary delegates only bypass detection to the residual observer', () => {
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  const observer = sliceBetween(
    source,
    'pi.on("tool_call", (event) => {',
    'pi.on("tool_execution_end"',
  )

  assert.match(observer, /capabilityBypassDetector\.observe\(event\)/u)
  assert.doesNotMatch(observer, /isRuntimeOwnedStageToolAllowed/u)
  assert.doesNotMatch(observer, /isToolAllowed/u)
  assert.doesNotMatch(observer, /usedLevelToolsThisCoordinatorTurn\.add/u)
})

test('Team Runtime closes the assignment capability evidence writer on session shutdown', () => {
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  const shutdownHandler = sliceBetween(
    source,
    'pi.on("session_shutdown",',
    '// ── Commands ──',
  )

  // The handler runs the session route in runtime-teardown.ts with the ports
  // index.ts builds once.
  assert.match(
    shutdownHandler,
    /teardownOnSessionShutdown\(runtimeTeardownPorts\)/u,
  )
  assert.match(
    source,
    /const runtimeTeardownPorts = makeRuntimeTeardownPorts\(\);/u,
  )
  // The session route closes the writer its port reads, when there is one.
  const moved = fs.readFileSync(RUNTIME_TEARDOWN_PATH, 'utf8')
  const sessionRoute = sliceBetween(
    moved,
    'export async function teardownOnSessionShutdown(',
    'function clearTimersThenPersist(',
  )
  assert.match(
    sessionRoute,
    /await ports\.writers\.evidenceWriter\(\)\?\.close\(\)\.catch\(/u,
  )
  // That port reads the capability evidence writer.
  const ports = sliceBetween(
    source,
    'function makeRuntimeTeardownPorts(): RuntimeTeardownPorts {',
    'const runtimeTeardownPorts = makeRuntimeTeardownPorts();',
  )
  assert.match(
    ports,
    /evidenceWriter: \(\) => capabilityEvidenceWriter,/u,
  )
})

test('Team Runtime registers only governed definitions and the single-dispatch skill gateway', () => {
  // Level tool arming moved to level-tools.ts, which registers through the
  // host registrar index.ts gives it.
  const moved = fs.readFileSync(LEVEL_TOOLS_PATH, 'utf8')
  const registeredExpressions = Array.from(
    moved.matchAll(/registrar\.registerTool\(([^\n;]+)\);/gu),
    (match) => match[1]?.trim(),
  )

  assert.deepEqual(registeredExpressions, [
    'governed.definition',
    'skillLoaderTool',
  ])
  assert.equal(
    Array.from(moved.matchAll(/\.registerTool\(/gu)).length,
    2,
    'level-tools.ts registers only through the host registrar',
  )

  // index.ts calls the host's registerTool in one place: the registrar it
  // hands level-tools.ts, which forwards the definition it is given.
  const indexSource = fs.readFileSync(INDEX_PATH, 'utf8')
  assert.deepEqual(
    Array.from(
      indexSource.matchAll(/\.registerTool\(([^\n;]+)\);/gu),
      (match) => match[1]?.trim(),
    ),
    ['definition'],
  )
  assert.match(
    indexSource,
    /registrar: \{\s*registerTool: \(definition\) => \{\s*ctx\.pi\.registerTool\(definition\);\s*\},/u,
  )

  const source = [indexSource, moved].join('\n')
  for (const toolName of [
    'set_roster',
    'create_brief',
    'converse',
    'dispatch',
    'handoff',
    'broadcast',
    'submit_for_review',
  ]) {
    assert.match(
      source,
      new RegExp(
        `createEngineToolAdapterFactory\\(\\{[\\s\\S]*?toolName: "${toolName}"`,
        'u',
      ),
    )
  }
  for (const toolName of ['spawn_team', 'spawn_workflow']) {
    assert.match(
      source,
      new RegExp(
        `createDelegationToolAdapterFactory\\(\\{[\\s\\S]*?toolName: "${toolName}"`,
        'u',
      ),
    )
  }
  assert.match(source, /registerEnabledPipelinePiTools\(\{/u)

  // The session start's checkpoint adoption decisions moved to a pure module;
  // it registers no tool.
  const movedAdoption = fs.readFileSync(CHECKPOINT_ADOPTION_PATH, 'utf8')
  assert.doesNotMatch(movedAdoption, /registerTool\(/u)

  // The boot's decisions moved to a pure module; it registers no tool.
  const movedBoot = fs.readFileSync(TEAM_BOOT_PATH, 'utf8')
  assert.doesNotMatch(movedBoot, /registerTool\(/u)

  // The host turn lifecycle moved out of index.ts; it registers no tool.
  const movedTurnLifecycle = fs.readFileSync(HOST_TURN_LIFECYCLE_PATH, 'utf8')
  assert.doesNotMatch(movedTurnLifecycle, /registerTool\(/u)
  // It works through the ports index.ts gives it and never sees the runtime
  // context itself.
  assert.doesNotMatch(movedTurnLifecycle, /\bctx\b|\bRuntimeContext\b/u)

  // The two teardown routes moved out of index.ts; the module registers no
  // tool and never sees the runtime context.
  const movedTeardown = fs.readFileSync(RUNTIME_TEARDOWN_PATH, 'utf8')
  assert.doesNotMatch(movedTeardown, /registerTool\(/u)
  assert.doesNotMatch(movedTeardown, /\bctx\b|\bRuntimeContext\b/u)
})

test('Team Runtime autostart invokes governed runtime entries rather than Pi definitions', () => {
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  const autostart = sliceBetween(
    source,
    'async function startActiveLevel',
    '// ── State Persistence',
  )

  assert.match(autostart, /currentToolInvokers\.get/u)
  assert.doesNotMatch(autostart, /currentToolDefinitions/u)
  assert.doesNotMatch(autostart, /\.execute\(/u)

  // The runtime-owned stage protocol moved to its own module; it receives the
  // governed invoker from index.ts and calls it.
  const moved = fs.readFileSync(STAGE_AUTOSTART_PATH, 'utf8')
  assert.match(moved, /\.invoker\.invoke\(/u)
  assert.doesNotMatch(moved, /currentToolDefinitions/u)
  assert.doesNotMatch(moved, /\.execute\(/u)

  // The discussion lead's coordinator call and the discussion pass loop moved
  // to their own module too; the loop receives the three governed invokers
  // from index.ts and calls them.
  const movedDiscussion = fs.readFileSync(DISCUSSION_AUTOSTART_PATH, 'utf8')
  for (const invoker of ['setRosterTool', 'createBriefTool', 'converseTool']) {
    assert.match(movedDiscussion, new RegExp(`${invoker}\\.invoke\\(`, 'u'))
  }
  assert.doesNotMatch(movedDiscussion, /currentToolDefinitions/u)
  assert.doesNotMatch(movedDiscussion, /\.execute\(/u)

  // The recovery prelude's decisions moved to a pure module; it invokes no
  // tool.
  const movedRecovery = fs.readFileSync(STAGE_RECOVERY_PATH, 'utf8')
  assert.doesNotMatch(movedRecovery, /currentToolDefinitions/u)
  assert.doesNotMatch(movedRecovery, /\.execute\(/u)
})

/**
 * The guard that keeps one refusal sentence honest.
 *
 * `runtime_owned_tool_denied` ends "Nothing to change here." That is only true
 * because a stage with no coordinator can reach a tool call for one reason: it
 * names nobody. The other way `getCurrentCoordinator` returns nothing — a stage
 * naming an agent that never loaded — is stopped at boot by this preflight,
 * over every level, before any tool is registered. If that call leaves `boot`,
 * or stops failing the boot, the copy starts telling a reader with a misnamed
 * coordinator to stop looking.
 */
test('a level declaring a coordinator that never loaded fails the boot, so no tool call can reach the policy', () => {
  const source = fs.readFileSync(INDEX_PATH, 'utf8')
  const boot = sliceBetween(
    source,
    'async function boot(cwd: string): Promise<boolean> {',
    '// ── Current level helpers ──',
  )

  // Every level, not the entry level: `validateDeclaredCoordinators` walks the
  // whole list (`domains/provider/provider-preflight.ts:158`).
  assert.match(
    boot,
    /validateDeclaredCoordinators\(\{[\s\S]*?levels: ctx\.teamConfig\.levels/u,
  )
  assert.match(
    boot,
    /loadedAgentNames: new Set\(ctx\.agents\.keys\(\)\)/u,
  )
  // And the errors it returns stop the boot rather than being collected and
  // walked past.
  assert.match(
    boot,
    /if \(ctx\.configErrors\.length > 0\) \{\s*\n\s*return false;/u,
  )
  // The boot's decisions moved to `team-boot.ts`. It returns values and reads
  // no runtime context, so the preflight's errors reach that check only
  // through `boot`.
  const movedBoot = fs.readFileSync(TEAM_BOOT_PATH, 'utf8')
  assert.doesNotMatch(movedBoot, /validateDeclaredCoordinators/u)
  assert.doesNotMatch(movedBoot, /\bctx\b/u)
})

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}
