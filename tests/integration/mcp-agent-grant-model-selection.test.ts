/**
 * Which pair decides whether an Agent may be granted an MCP server.
 *
 * An Agent runs with its own provider and model, or with the one application
 * default. `McpAgentGrantsService` did not ask that question. It filled a
 * missing pair half at a time — `agent.provider ?? 'codex'` and
 * `agent.model ?? 'default'` — and asked whether *that* stitched pair supports
 * MCP tools. `codex/default` is this repository's "nothing chosen" sentinel, so
 * an Agent that had simply chosen nothing was reported incompatible and refused
 * a grant, while the application default it would actually have run on supports
 * MCP perfectly well.
 *
 * That is an authorization outcome, not a label: `listServers` computes
 * `compatible` from the answer and `setGrant` refuses to enable a grant for an
 * incompatible server.
 *
 * Driven against the real grants service, the real settings service, the real
 * support resolver and real persona files on a real temporary filesystem. No
 * internal module is replaced and no provider is called: what is under test is
 * which pair the question is asked about.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import {
  McpAgentGrantsService,
  McpAgentGrantsServiceError,
} from '../../services/mcp-agent-grants-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'

const APP_DEFAULT = { provider: 'openai', model: 'app-default-model' }
/** A different provider, deliberately, so precedence is provable. */
const EXPLICIT_PAIR = { provider: 'anthropic', model: 'explicit-agent-model' }
const SERVER_NAME = 'Notes'
const STDIO_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)

interface Fixture {
  readonly grants: McpAgentGrantsService
  readonly settings: McpSettingsService
  readonly serverId: string
  cleanUp(): Promise<void>
}

function writeAgent(
  projectRoot: string,
  name: string,
  pair?: { provider?: string; model?: string },
): void {
  const directory = path.join(projectRoot, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `description: Agent used by the MCP grant selection test.`,
      ...(pair?.provider ? [`provider: ${pair.provider}`] : []),
      ...(pair?.model ? [`model: ${pair.model}`] : []),
      '---',
      '',
      `# ${name}`,
      '',
      'Answer briefly.',
      '',
    ].join('\n'),
  )
}

async function makeFixture(): Promise<Fixture> {
  const projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-grant-selection-')),
  )
  const userDataPath = path.join(projectRoot, 'user-data')
  fs.mkdirSync(userDataPath, { recursive: true })

  const previousDefault = getRuntimeDefaultModelState()
  setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })

  const settings = new McpSettingsService({
    storagePath: path.join(userDataPath, 'mcp-settings.json'),
  })
  // Everything after this point can fail, and a failure here leaves a real
  // child process and a real temporary directory behind. The cleanup is
  // therefore attached before the first thing that can throw, not after the
  // fixture is fully built.
  const cleanUp = async (): Promise<void> => {
    await settings.closeAll()
    setRuntimeDefaultModelState(previousDefault)
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
  try {
    // A real MCP server, saved and validated the way Settings does it. Nothing
    // about model choice can be shown against a server that never connected:
    // `setAgentGrant` requires a connected status, so an unvalidated
    // placeholder would fail for that reason and prove nothing about which pair
    // was asked about. This is the owned stdio fixture the grants API test uses.
    const server = await settings.saveServer({
      name: SERVER_NAME,
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE_PATH],
        cwd: process.cwd(),
      },
    })
    const validated = await settings.validateServer(server.id, {
      stdioTrustAcknowledged: true,
    })
    assert.equal(validated.status, 'connected', JSON.stringify(validated))
    // Enabled by saving it, so nothing here re-enables what is already on.
    assert.equal(validated.enabled, true, JSON.stringify(validated))

    writeAgent(projectRoot, 'inheriting-agent')
    // A provider of its own that is *not* the application default, so this can
    // show precedence. An explicit Agent on the same pair as the default would
    // agree with the wrong rule as readily as the right one.
    writeAgent(projectRoot, 'explicit-agent', EXPLICIT_PAIR)
    // Half a pair is not a choice, and completing it is the guesswork this
    // corrects. Both halves, because they are read by different branches: a
    // model with no provider, and a provider whose model was left out.
    writeAgent(projectRoot, 'partial-agent', { model: 'orphaned-model' })
    writeAgent(projectRoot, 'provider-only-agent', { provider: 'anthropic' })
    // The legacy way of saying "nothing chosen", which still means inherit.
    writeAgent(projectRoot, 'legacy-agent', { model: 'default' })

    return {
      grants: new McpAgentGrantsService({
        repoRootPath: projectRoot,
        settingsService: settings,
      }),
      settings,
      serverId: server.id,
      // Closes the real client and its child process: a validated stdio server
      // leaves one running, and a test that only removed its directory would
      // leak it into the rest of the suite.
      cleanUp,
    }
  } catch (error) {
    await cleanUp()
    throw error
  }
}

test('an Agent that chose nothing is judged on the application default it would use', async () => {
  const fixture = await makeFixture()
  try {
    const [inheriting] = await fixture.grants.listServers('inheriting-agent')
    const [explicit] = await fixture.grants.listServers('explicit-agent')
    assert.ok(inheriting && explicit)

    // Judged on the application default, which supports MCP. Choosing nothing
    // is not choosing the Codex CLI.
    assert.equal(inheriting.compatible, true, JSON.stringify(inheriting))
    assert.doesNotMatch(String(inheriting.reason ?? ''), /codex/i)

    // And an Agent that named a *different* provider is judged on that one —
    // here, one whose adapter genuinely has no parent tool loop, so it is
    // reported incompatible. That is the point: the Agent's own choice decides
    // even when the application default would have given the nicer answer. Two
    // Agents on the same pair could not tell a rule that honours the choice
    // from one that ignores it.
    assert.equal(explicit.compatible, false, JSON.stringify(explicit))
    assert.equal(explicit.providerSupportReasonCode, 'provider_adapter_unavailable')
  } finally {
    await fixture.cleanUp()
  }
})

test('a legacy "model: default" Agent inherits rather than naming the Codex CLI', async () => {
  // The historical way of writing "nothing chosen". It means inherit, and it
  // has meant that everywhere else since the sentinel was retired.
  const fixture = await makeFixture()
  try {
    const [legacy] = await fixture.grants.listServers('legacy-agent')
    assert.ok(legacy)
    assert.equal(legacy.compatible, true, JSON.stringify(legacy))
    assert.doesNotMatch(String(legacy.reason ?? ''), /codex/i)
  } finally {
    await fixture.cleanUp()
  }
})

test('half a pair is refused rather than completed', async () => {
  // Half a pair is genuinely ambiguous, and guessing the missing half is
  // exactly what produced the wrong answer here. Falling back to the
  // application default instead would be the same mistake in a nicer costume:
  // it would grant on a pair the Agent's own file contradicts. Both halves are
  // covered, because the reading treats them as different cases.
  const fixture = await makeFixture()
  try {
    for (const agentName of ['partial-agent', 'provider-only-agent']) {
      const [partial] = await fixture.grants.listServers(agentName)
      assert.ok(partial, agentName)
      assert.equal(partial.compatible, false, `${agentName}: ${JSON.stringify(partial)}`)
      assert.doesNotMatch(String(partial.reason ?? ''), /codex/i)

      await assert.rejects(
        () => fixture.grants.setGrant(agentName, fixture.serverId, true),
        (error: unknown) =>
          error instanceof McpAgentGrantsServiceError &&
          error.code === 'provider_unsupported',
      )
    }
    assert.deepEqual(await fixture.settings.listAgentGrants(), [])
  } finally {
    await fixture.cleanUp()
  }
})

test('an Agent that chose nothing may be granted a server', async () => {
  // The outcome that makes this more than a label. `setGrant` refuses an
  // incompatible server, so a wrongly stitched pair does not merely read badly
  // — it withholds an authorization the Agent's real pair supports.
  const fixture = await makeFixture()
  try {
    const granted = await fixture.grants.setGrant(
      'inheriting-agent',
      fixture.serverId,
      true,
    )
    assert.equal(granted.granted, true)

    // And the grant is the one the settings service actually persisted, still
    // default-off for everybody else.
    const stored = await fixture.settings.listAgentGrants()
    assert.equal(stored.length, 1, JSON.stringify(stored))
    assert.equal(stored[0]?.enabled, true)
  } finally {
    await fixture.cleanUp()
  }
})

test('a granted server stays revocable after its pair stops resolving', async () => {
  // Revocation must not depend on the Agent still having a usable model.
  // `setGrant` lists servers before it checks the enable guard, so a resolution
  // failure raised while listing would take the grant away from the person who
  // needs to remove it — leaving an enabled authorization nobody can turn off.
  // Only *enabling* is refused.
  const fixture = await makeFixture()
  try {
    await fixture.grants.setGrant('inheriting-agent', fixture.serverId, true)
    setRuntimeDefaultModelState({
      status: 'unavailable',
      provider: APP_DEFAULT.provider,
      model: APP_DEFAULT.model,
    })

    // The row is still there, still says it is granted, and still explains why
    // it cannot be enabled again.
    const [listed] = await fixture.grants.listServers('inheriting-agent')
    assert.ok(listed)
    assert.equal(listed.granted, true)
    assert.equal(listed.compatible, false)
    // A configured default that cannot run stays *identifiable*. The point of
    // keeping the pair on an unavailable state is that a person is told which
    // selection is broken; a reason saying only that something is unavailable
    // leaves them to guess which model to go and fix.
    assert.match(String(listed.reason ?? ''), /openai/)
    assert.match(String(listed.reason ?? ''), /app-default-model/)

    const revoked = await fixture.grants.setGrant(
      'inheriting-agent',
      fixture.serverId,
      false,
    )
    assert.equal(revoked.granted, false)
    assert.deepEqual(
      (await fixture.settings.listAgentGrants()).filter((grant) => grant.enabled),
      [],
    )
  } finally {
    await fixture.cleanUp()
  }
})

test('an unusable application default leaves an inheriting Agent visibly unable', async () => {
  // The other half of the rule. With nothing usable to inherit, the Agent has
  // no pair at all — and that is reported as such rather than papered over with
  // a substituted one. Refusing the grant here is right; refusing it while
  // naming a model nobody chose is what this corrects.
  const fixture = await makeFixture()
  setRuntimeDefaultModelState({ status: 'unset' })
  try {
    const [server] = await fixture.grants.listServers('inheriting-agent')
    assert.ok(server)
    assert.equal(server.compatible, false)
    assert.ok(server.reason, 'an incompatible server has to say why')
    // Not a claim about the Codex CLI, which nobody selected.
    assert.doesNotMatch(String(server.reason), /codex/i)
    // And it names what is actually missing.
    assert.match(String(server.reason), /application default/i)

    await assert.rejects(
      () => fixture.grants.setGrant('inheriting-agent', fixture.serverId, true),
      (error: unknown) =>
        error instanceof McpAgentGrantsServiceError &&
        error.code === 'provider_unsupported',
    )
    assert.deepEqual(await fixture.settings.listAgentGrants(), [])
  } finally {
    await fixture.cleanUp()
  }
})
