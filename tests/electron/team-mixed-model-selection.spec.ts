/**
 * A Team whose members run on different models — and on none of the Team's
 * choosing.
 *
 * The rule under test is that Team membership never selects a model: every
 * member runs on its own Agent pair, or on the one application default, and the
 * Team is only a roster. That is only convincing if all three cases sit side by
 * side in one Team, which is what these journeys build through the real Create
 * interface and then run.
 *
 * The Team itself is created through the team-builder domain rather than the
 * screen, because Create has no blank-Team form: a Team is authored by the
 * Agent Architect, which `agents-and-teams-creation.spec.ts` already
 * covers end to end. Everything this test is actually about — each member's
 * model choice, the roster membership, and the effective-pair preview — is
 * driven through the real renderer and the real desktop API.
 */
import {
  _electron as electron,
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  addTeamBuilderAgent,
  createTeamBuilderTeam,
} from '../../domains/agent-generator/team-manager.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import {
  ANALYST_MODEL,
  APP_DEFAULT_MODEL,
  EDITOR_MODEL,
  FIXTURE_PROVIDER,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from './support/model-selection-fixture.js'

const TEAM_ID = 'mixed-model-team'
const TEAM_LABEL = 'Mixed Model Team'

const ANALYST = { name: 'mixed-analyst', label: 'Mixed Analyst' }
const EDITOR = { name: 'mixed-editor', label: 'Mixed Editor' }
const SCRIBE = { name: 'mixed-scribe', label: 'Mixed Scribe' }

const ANALYST_MARKER = 'MARKER-MIXED-ANALYST'
const EDITOR_MARKER = 'MARKER-MIXED-EDITOR'
const SCRIBE_MARKER = 'MARKER-MIXED-SCRIBE'

/** A phrase only the title helper's own system prompt carries. */
const TITLE_PROMPT_MARKER = 'session title that summarizes'
const TEAM_GENERATED_TITLE = 'Reviewing The Warehouse Automation Brief'

/**
 * The pair this session recorded as having named it, and where it came from.
 *
 * Read whole from the durable record rather than from anything on screen, so
 * the assertions afterwards are that the page shows what was stored — not that
 * two renderings of the same guess agree. Returns `null` until a launch has
 * recorded one, so it can be polled.
 */
async function teamLaunchTitleSelection(
  workspacePath: string,
): Promise<Record<string, unknown> | null> {
  const sessionsRoot = path.join(workspacePath, 'sessions')
  const entries = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const raw = await fs
      .readFile(path.join(sessionsRoot, entry.name, 'session.json'), 'utf8')
      .catch(() => '')
    if (raw === '') continue
    const metadata: unknown = JSON.parse(raw)
    if (typeof metadata !== 'object' || metadata === null) continue
    const attempts = Reflect.get(metadata, 'titleAttempts')
    if (!Array.isArray(attempts)) continue
    const launch = attempts.find(
      (attempt: unknown) =>
        typeof attempt === 'object' &&
        attempt !== null &&
        Reflect.get(attempt, 'operation') === 'team-launch',
    )
    if (launch === undefined) continue
    const selection = Reflect.get(launch, 'selection')
    if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) {
      continue
    }
    const record: Record<string, unknown> = {}
    for (const key of ['provider', 'model', 'source', 'reason', 'caller']) {
      record[key] = Reflect.get(selection, key)
    }
    return record
  }
  return null
}

/**
 * Three Agents that all start out inheriting the application default.
 *
 * Starting them identical is deliberate: the differences the roster preview
 * later reports have to have been made through the Create screen in this
 * journey, not baked into a fixture file.
 */
async function seedInheritingAgents(projectRoot: string): Promise<void> {
  await Promise.all([
    writeAgentPersona(projectRoot, {
      name: ANALYST.name,
      description: 'Analyses the brief.',
      marker: ANALYST_MARKER,
      tier: 'execution',
    }),
    writeAgentPersona(projectRoot, {
      name: EDITOR.name,
      description: 'Edits the analysis.',
      marker: EDITOR_MARKER,
      tier: 'execution',
    }),
    writeAgentPersona(projectRoot, {
      name: SCRIBE.name,
      description: 'Writes the result down.',
      marker: SCRIBE_MARKER,
      tier: 'execution',
    }),
  ])
}

function leftSidebar(page: Page): Locator {
  return page.locator('[data-slot="workspace-sidebar"][data-side="left"]')
}

async function openCreateTab(page: Page, tab: 'Agents' | 'Teams'): Promise<void> {
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  await page
    .getByLabel('Resource type')
    .getByRole('tab', { name: tab, exact: true })
    .click()
}

/**
 * Give one Agent its own explicit pair, through the controls a person uses.
 *
 * One picker carries both halves of the decision: "Use app default" is its
 * first entry, and picking any model below it gives the Agent its own pair.
 */
async function chooseAgentModel(
  page: Page,
  agentLabel: string,
  modelName: string,
): Promise<void> {
  await leftSidebar(page)
    .getByRole('button', { name: new RegExp(`^${agentLabel}\\b`) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Agent model', exact: true }).click()
  // Picking the model saves it; there is no Save button.
  await page.getByText(modelName, { exact: true }).click()
}

/** Add one library Agent to the open Team's roster. */
async function addRosterMember(page: Page, agentLabel: string): Promise<void> {
  await page.getByLabel('Add agent').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('Select agent...').click()
  await page.getByRole('option', { name: agentLabel, exact: true }).click()
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** The roster card for one member, inside the Team inspector's Agent Roster. */
function rosterEntry(page: Page, agentLabel: string): Locator {
  return page.getByRole('listitem').filter({ hasText: agentLabel })
}

/**
 * What the roster says one member will actually run with. The card shows it
 * only on the provider icon's hover label, not as badges under the role.
 */
async function expectRosterRuntime(
  page: Page,
  agentLabel: string,
  expected: { modelId: string },
): Promise<void> {
  const entry = rosterEntry(page, agentLabel)
  await expect(entry).toHaveCount(1)
  await expect(entry.getByLabel(`Model: ${expected.modelId}`)).toHaveCount(1)
}

test('a Team saved in Create previews every member on its own resolved pair, and still does after reopening', async ({}, testInfo) => {
  test.setTimeout(240_000)

  // No turn is sent in this journey; the provider exists so the desktop has a
  // reachable connection behind the catalog it renders.
  const provider = await startFakeChatCompletionsServer({
    script: [{ content: 'Unused in this journey.' }],
  })

  const workspacePath = testInfo.outputPath('roster-workspace')
  const projectRoot = testInfo.outputPath('roster-project')
  const userDataPath = testInfo.outputPath('roster-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedInheritingAgents(projectRoot),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
    }),
  ])
  await createTeamBuilderTeam(projectRoot, {
    id: TEAM_ID,
    description: 'Three members, three different runtimes.',
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()

    // ── Two members are given their own, different pairs ───────────────────
    await openCreateTab(page, 'Agents')
    await chooseAgentModel(page, ANALYST.label, ANALYST_MODEL.name)
    await chooseAgentModel(page, EDITOR.label, EDITOR_MODEL.name)
    // The third is deliberately left alone, so the Team carries all three
    // states the product allows.

    const personaPath = (agentName: string): string =>
      path.join(projectRoot, 'agents', agentName, `${agentName}.md`)
    await expect
      .poll(() => fs.readFile(personaPath(ANALYST.name), 'utf8'), {
        timeout: 30_000,
      })
      .toContain(`model: ${ANALYST_MODEL.id}`)
    await expect
      .poll(() => fs.readFile(personaPath(EDITOR.name), 'utf8'), {
        timeout: 30_000,
      })
      .toContain(`model: ${EDITOR_MODEL.id}`)
    // Inheritance is the *absence* of a pair, never a copy of today's default.
    expect(await fs.readFile(personaPath(SCRIBE.name), 'utf8')).not.toContain(
      'model:',
    )

    // ── All three join the Team's roster ───────────────────────────────────
    await openCreateTab(page, 'Teams')
    await leftSidebar(page)
      .getByRole('button', { name: new RegExp(`^${TEAM_LABEL}\\b`) })
      .first()
      .click()
    await expect(page.getByText('Agent Roster')).toBeVisible({ timeout: 30_000 })
    await addRosterMember(page, ANALYST.label)
    await addRosterMember(page, EDITOR.label)
    await addRosterMember(page, SCRIBE.label)

    // ── The preview reports each member's effective pair and its source ────
    await expectRosterRuntime(page, ANALYST.label, {
      modelId: ANALYST_MODEL.id,
    })
    await expectRosterRuntime(page, EDITOR.label, {
      modelId: EDITOR_MODEL.id,
    })
    await expectRosterRuntime(page, SCRIBE.label, {
      modelId: APP_DEFAULT_MODEL.id,
    })

    // The saved Team names its members and nothing about their models. A Team
    // that had copied today's pairs into its own file would preview the same
    // way today and diverge the moment an Agent was edited.
    const teamYaml = await fs.readFile(
      path.join(projectRoot, 'teams', TEAM_ID, 'team.yaml'),
      'utf8',
    )
    expect(
      [...teamYaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map(
        (match) => match[1],
      ),
    ).toEqual([ANALYST.name, EDITOR.name, SCRIBE.name])
    expect(teamYaml).not.toContain(ANALYST_MODEL.id)
    expect(teamYaml).not.toContain(EDITOR_MODEL.id)
    expect(teamYaml).not.toContain(APP_DEFAULT_MODEL.id)
    expect(teamYaml).not.toContain(FIXTURE_PROVIDER)

    // ── Reopened from disk, the preview says exactly the same thing ────────
    await page.reload()
    await openCreateTab(page, 'Teams')
    await leftSidebar(page)
      .getByRole('button', { name: new RegExp(`^${TEAM_LABEL}\\b`) })
      .first()
      .click()
    await expect(page.getByText('Agent Roster')).toBeVisible({ timeout: 30_000 })

    await expectRosterRuntime(page, ANALYST.label, {
      modelId: ANALYST_MODEL.id,
    })
    await expectRosterRuntime(page, EDITOR.label, {
      modelId: EDITOR_MODEL.id,
    })
    await expectRosterRuntime(page, SCRIBE.label, {
      modelId: APP_DEFAULT_MODEL.id,
    })
  } finally {
    await app.close()
    await provider.close()
  }
})

test('running a mixed-model Team dispatches every member on its own resolved pair', async ({}, testInfo) => {
  test.setTimeout(360_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: 'The analyst has read the brief.',
        match: (request) => request.systemPrompt?.includes(ANALYST_MARKER) ?? false,
      },
      {
        content: 'The editor has tightened it.',
        match: (request) => request.systemPrompt?.includes(EDITOR_MARKER) ?? false,
      },
      {
        content: 'The scribe has written it down.',
        match: (request) => request.systemPrompt?.includes(SCRIBE_MARKER) ?? false,
      },
      // Everything else the desktop asks for during a Team run — session
      // titling, coordination probes — answers harmlessly and is filtered out
      // of every assertion below by persona marker.
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const workspacePath = testInfo.outputPath('run-workspace')
  const projectRoot = testInfo.outputPath('run-project')
  const userDataPath = testInfo.outputPath('run-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedInheritingAgents(projectRoot),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      // Keyless LM Studio: the native tool route refuses a keyless
      // OpenAI-compatible connection.
      kind: 'lm-studio',
    }),
  ])
  // The two explicit pairs are written straight into the personas here. The
  // journey above is what proves the Create screen writes exactly this; asking
  // it to be re-driven would make one long test fail for authoring reasons
  // while claiming something about running.
  await writeAgentPersona(projectRoot, {
    name: ANALYST.name,
    description: 'Analyses the brief.',
    marker: ANALYST_MARKER,
    tier: 'execution',
    provider: FIXTURE_PROVIDER,
    model: ANALYST_MODEL.id,
  })
  await writeAgentPersona(projectRoot, {
    name: EDITOR.name,
    description: 'Edits the analysis.',
    marker: EDITOR_MARKER,
    tier: 'execution',
    provider: FIXTURE_PROVIDER,
    model: EDITOR_MODEL.id,
  })
  await createTeamBuilderTeam(projectRoot, {
    id: TEAM_ID,
    description: 'Three members, three different runtimes.',
  })
  // The same operation the Create roster's "Add agent" dialog performs.
  for (const agentName of [ANALYST.name, EDITOR.name, SCRIBE.name]) {
    await addTeamBuilderAgent({ repoRoot: projectRoot, teamId: TEAM_ID, agentName })
  }

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: TEAM_LABEL }).click()

    const participants = page.getByRole('complementary', {
      name: 'Team participants',
    })
    await expect(participants).toBeVisible({ timeout: 60_000 })

    // Before anything runs, the rail advertises each member's resolved pair.
    // These labels come from the Team's configuration through the same rule the
    // roster preview uses, so this is the promise the run then has to keep.
    await expect(
      participants.getByLabel(`Model: ${ANALYST_MODEL.id}`),
    ).toHaveCount(1)
    await expect(
      participants.getByLabel(`Model: ${EDITOR_MODEL.id}`),
    ).toHaveCount(1)
    await expect(
      participants.getByLabel(`Model: ${APP_DEFAULT_MODEL.id}`),
    ).toHaveCount(1)

    const composer = page.getByRole('textbox').first()
    await composer.fill('Summarise the brief for the board.')
    await composer.press('Enter')

    // ── What each member actually ran on, from the provider's own record ───
    const modelsSentFor = (marker: string): string[] => [
      ...new Set(
        provider.requests
          .filter((request) => request.systemPrompt?.includes(marker))
          .map((request) => request.model ?? ''),
      ),
    ]
    for (const [marker, expectedModelId] of [
      [ANALYST_MARKER, ANALYST_MODEL.id],
      [EDITOR_MARKER, EDITOR_MODEL.id],
      [SCRIBE_MARKER, APP_DEFAULT_MODEL.id],
    ] as const) {
      // Polled on the set of distinct ids rather than on a count, so a member
      // dispatched more than once still has to have used one pair throughout,
      // and a member dispatched on the wrong pair fails rather than waits.
      await expect
        .poll(() => modelsSentFor(marker), { timeout: 150_000 })
        .toEqual([expectedModelId])
    }

    // Once a member has run, the rail reports the model the *provider* named in
    // its response rather than the id that was requested, so the labels above
    // are deliberately not re-asserted here: the shared fake provider answers
    // with one constant model for every call, and re-asserting them would test
    // the fixture. What the run actually asked for is proven on the wire above.

    // Exactly one member is described as using the app default, and it is the
    // one that chose nothing. The other two made a choice, so they are not
    // described as inheriting one — even though they are on the same Team.
    const memberCard = (label: string): Locator =>
      participants
        .getByText(label, { exact: true })
        .locator('xpath=ancestor::section[1]')
    await expect(
      memberCard(SCRIBE.label).getByText('app default', { exact: true }),
    ).toBeVisible({ timeout: 120_000 })
    await expect(
      memberCard(ANALYST.label).getByText('app default', { exact: true }),
    ).toHaveCount(0)
    await expect(
      memberCard(EDITOR.label).getByText('app default', { exact: true }),
    ).toHaveCount(0)
    await expect(
      participants.getByText('app default', { exact: true }),
    ).toHaveCount(1)
  } finally {
    await app.close()
    await provider.close()
  }
})

/**
 * Team session naming retains its model-selection record without adding
 * informational cards to the chat, including after reopening the session.
 */
test('a Team run records its naming model without cards after reopening', async ({}, testInfo) => {
  test.setTimeout(360_000)

  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: 'The scribe has written it down.',
        match: (request) => request.systemPrompt?.includes(SCRIBE_MARKER) ?? false,
      },
      {
        // Four words or more, because a shorter one is refused as a title and
        // this journey is about the notice a successful naming leaves.
        content: TEAM_GENERATED_TITLE,
        match: (request) =>
          request.systemPrompt?.includes(TITLE_PROMPT_MARKER) ?? false,
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const workspacePath = testInfo.outputPath('team-title-workspace')
  const projectRoot = testInfo.outputPath('team-title-project')
  const userDataPath = testInfo.outputPath('team-title-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    seedInheritingAgents(projectRoot),
    seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      // Keyless LM Studio: the native tool route refuses a keyless
      // OpenAI-compatible connection.
      kind: 'lm-studio',
    }),
  ])
  await createTeamBuilderTeam(projectRoot, {
    id: TEAM_ID,
    description: 'One member, so this journey is about the naming and nothing else.',
  })
  await addTeamBuilderAgent({ repoRoot: projectRoot, teamId: TEAM_ID, agentName: SCRIBE.name })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('tab', { name: 'Teams', exact: true }).click()
    await page.getByRole('radio', { name: TEAM_LABEL }).click()

    const composer = page.getByRole('textbox').first()
    await composer.fill('Summarise the warehouse automation brief for the board.')
    await composer.press('Enter')

    // The record has to exist before anything is asserted about the page, and
    // it is what the page is then checked against.
    await expect
      .poll(() => teamLaunchTitleSelection(workspacePath), { timeout: 150_000 })
      .not.toBeNull()
    const recorded = await teamLaunchTitleSelection(workspacePath)
    expect(recorded).not.toBeNull()
    if (recorded === null) throw new Error('no title selection was recorded')
    // Stated independently as well as joined, provenance included: nobody
    // picked a model for this launch, so the pair can only have come from the
    // one application default, and the notice reads differently for the two.
    expect(recorded).toEqual({
      provider: FIXTURE_PROVIDER,
      model: APP_DEFAULT_MODEL.id,
      source: 'app-default',
      reason: 'agent-default',
      caller: 'title',
    })

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)

    const rendered = testInfo.outputPath('team-title-notice.png')
    await page.screenshot({ path: rendered })
    await testInfo.attach('team-title-notice', {
      path: rendered,
      contentType: 'image/png',
    })

    // ── Reopened. Renderer state is discarded; the record is not ────────────
    await page.reload()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await leftSidebar(page)
      .getByRole('button', { name: new RegExp(`^${TEAM_GENERATED_TITLE}`) })
      .first()
      .click()
    // A session whose newest task is a Team run has no target picker (1d7b8767).
    await expect(page.getByRole('button', { name: 'Team is fixed for this session' })).toBeDisabled()
    await expect(page.getByRole('region', { name: 'Run chat' }).getByRole('log').getByText('Summarise the warehouse automation brief for the board.')).toBeVisible()

    await expect(page.getByRole('note', { name: 'Model selection' })).toHaveCount(0)
  } finally {
    await app.close()
    await provider.close()
  }
})
