/**
 * A6.2 from the renderer through the API to the files.
 *
 * A Team write made against a version of the Team that has since changed on
 * disk is refused: the person sees the server's words, the Team on screen is
 * redrawn from disk, what they typed is kept, and nothing is written. The
 * unit tests prove the network boundary against a stand-in server; this
 * journey proves the same with the real desktop, the real API and the real
 * files.
 *
 * The only stand-in is the loopback model endpoint, which nothing here is
 * meant to call; it is there so that any provider check Create makes stays
 * on this machine. Every wait is on something the person sees or on the files
 * themselves.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { replaceRequiredText } from '../support/config-rewrite.js'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const TEAM_ID = 'line-team'
const TEAM_LABEL = 'Line Team'
/** What the Team editor shows as the description: the `teams.yaml` entry's. */
const LOADED_DESCRIPTION = 'Chain team used by the team-chat E2E'
/** The description line in the Team's own `team.yaml`. */
const TEAM_YAML_DESCRIPTION = 'description: Coordinator-free chain that runs its whole bench in order'
const OUTSIDE_DESCRIPTION = 'description: Changed outside the app while the editor was open'
const TYPED_DESCRIPTION = 'My unsaved description of the line team.'
/** The server's words for a write made against a Team that has changed since. */
const REFUSAL = 'Someone changed this team. This is how it stands now.'

interface Fixture {
  readonly workspacePath: string
  readonly projectRootPath: string
  readonly userDataPath: string
  readonly piStatePath: string
  readonly registryPath: string
  readonly teamPath: string
  readonly teamYamlPath: string
}

async function makeFixtureProject(
  outputPath: (name: string) => string,
  name: string,
): Promise<Fixture> {
  const workspacePath = outputPath(`${name}-workspace`)
  const projectRootPath = outputPath(`${name}-project`)
  const userDataPath = outputPath(`${name}-user-data`)
  const piStatePath = outputPath(`${name}-pi-state`)
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(path.join(repoRoot, 'tests', 'fixtures', 'team-chat-e2e'), projectRootPath, {
      recursive: true,
    }),
  ])
  // Pinned as team-chat.spec.ts pins them, so the Team's health depends on
  // this fixture and not on a developer's settings.
  for (const agentId of await fs.readdir(path.join(projectRootPath, 'agents'))) {
    const agentFile = path.join(projectRootPath, 'agents', agentId, `${agentId}.md`)
    const prompt = await fs.readFile(agentFile, 'utf8')
    await fs.writeFile(agentFile, `---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\n${prompt}`)
  }
  const teamPath = path.join(projectRootPath, 'teams', TEAM_ID)
  return {
    workspacePath,
    projectRootPath,
    userDataPath,
    piStatePath,
    registryPath: path.join(projectRootPath, 'teams.yaml'),
    teamPath,
    teamYamlPath: path.join(teamPath, 'team.yaml'),
  }
}

/** A roster entry added to the Team's `agents:` block, as an edit outside the app would add it. */
function withRosterEntry(file: string, source: string, agentName: string): string {
  return replaceRequiredText({
    file,
    pattern: '\n\nlevels:',
    replacement: [
      '',
      `  - name: ${agentName}`,
      '    type: agent',
      '    role: Added outside the app',
      '    tier: execution',
      '    tools: []',
      `    agent_file: ../../agents/${agentName}/${agentName}.md`,
      '',
      'levels:',
    ].join('\n'),
    source,
  })
}

function launchDesktop(fixture: Fixture, providerBaseUrl: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'team-revision-conflict-key',
      OPENAI_BASE_URL: providerBaseUrl,
      PI_CODING_AGENT_DIR: fixture.piStatePath,
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: fixture.projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: fixture.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: fixture.workspacePath,
    },
  })
}

/** Create's Teams list, as the person reaches it. */
async function openCreateTeams(page: Page): Promise<Locator> {
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  await page.getByLabel('Resource type').getByRole('tab', { name: 'Teams', exact: true }).click()
  return page.locator('[data-slot="workspace-sidebar"][data-side="left"]')
}

function teamRow(sidebar: Locator): Locator {
  return sidebar.getByRole('button', { name: new RegExp(`^${TEAM_LABEL}\\b`) }).first()
}

test('a Team details save made against a Team changed on disk is refused, shows the Team as it now stands and keeps what was typed', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const fixture = await makeFixtureProject((name) => testInfo.outputPath(name), 'editor-save')
  const provider = await startDeterministicOpenAiServer()
  // From here the server is owned: the launch and the journey run under one
  // guard, and teardown closes whatever was started, whatever failed.
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    app = await launchDesktop(fixture, provider.baseUrl)
    const page = await app.firstWindow()
    const sidebar = await openCreateTeams(page)
    await teamRow(sidebar).click()

    const details = page.locator('[data-slot="team-details-editor"]')
    const description = details.locator('textarea')
    const roster = page.locator('[data-slot="team-roster-editor"]')
    const memberAddedOutside = roster.getByRole('button', {
      name: 'Remove Spec Alpha from team roster',
      exact: true,
    })
    await expect(description).toHaveValue(LOADED_DESCRIPTION)
    await expect(
      roster.getByRole('button', { name: 'Remove Line One from team roster', exact: true }),
    ).toBeVisible()
    await expect(memberAddedOutside).toHaveCount(0)

    // Changed behind the app, after the editor loaded the Team: a new
    // description in the Team's own file, and a member the editor has not seen.
    const registryBefore = await fs.readFile(fixture.registryPath, 'utf8')
    const changedOutside = withRosterEntry(
      fixture.teamYamlPath,
      replaceRequiredText({
        file: fixture.teamYamlPath,
        pattern: TEAM_YAML_DESCRIPTION,
        replacement: OUTSIDE_DESCRIPTION,
        source: await fs.readFile(fixture.teamYamlPath, 'utf8'),
      }),
      'spec-alpha',
    )
    await fs.writeFile(fixture.teamYamlPath, changedOutside, 'utf8')

    await description.fill(TYPED_DESCRIPTION)
    await details.getByRole('button', { name: 'Save', exact: true }).click()

    // The save settles one way or the other on screen.
    const refused = details.getByText(REFUSAL, { exact: true })
    const saved = details.getByText('Saved', { exact: true })
    await expect(refused.or(saved)).toBeVisible()
    const outcome = (await refused.isVisible()) ? 'refused' : 'saved'
    expect(outcome, 'what the save made against the stale Team did').toBe('refused')

    // The Team is redrawn from disk: the member added outside is on screen.
    await expect(memberAddedOutside).toBeVisible()
    // What the person typed is theirs, and is still there.
    await expect(description).toHaveValue(TYPED_DESCRIPTION)
    // Nothing was written: the outside change stands byte for byte, and the
    // registry the save would also have rewritten is untouched.
    expect(await fs.readFile(fixture.teamYamlPath, 'utf8')).toBe(changedOutside)
    expect(await fs.readFile(fixture.registryPath, 'utf8')).toBe(registryBefore)
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => provider.close(),
  ])
})

test('a sidebar delete confirmed against a Team changed on disk is refused, stays refused on the same confirmation, and deletes only from the updated row', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const fixture = await makeFixtureProject((name) => testInfo.outputPath(name), 'sidebar-delete')
  const provider = await startDeterministicOpenAiServer()
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    app = await launchDesktop(fixture, provider.baseUrl)
    const page = await app.firstWindow()
    const sidebar = await openCreateTeams(page)
    const dialog = page.getByRole('dialog')
    const confirm = dialog.getByRole('button', { name: 'Yes, delete', exact: true })
    const refused = dialog.getByText(REFUSAL, { exact: true })
    // Each confirmation is observed by its own answer from the API, so a second
    // refusal cannot be mistaken for the first one still on screen.
    const teamDeletion = () =>
      page.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' &&
          new URL(response.url()).pathname.endsWith(`/create/team-builder/teams/${TEAM_ID}`),
      )
    const openDeleteConfirmation = async () => {
      const row = teamRow(sidebar)
      await expect(row).toBeVisible()
      await row.hover()
      await sidebar.getByRole('button', { name: `Delete ${TEAM_LABEL}`, exact: true }).click()
      await expect(dialog).toContainText(`Delete team “${TEAM_LABEL}”?`)
    }

    await openDeleteConfirmation()

    // Changed behind the app while the confirmation is open: a member whose
    // persona file does not exist, which the Team's health reports by name.
    const registryBefore = await fs.readFile(fixture.registryPath, 'utf8')
    const changedOutside = withRosterEntry(
      fixture.teamYamlPath,
      await fs.readFile(fixture.teamYamlPath, 'utf8'),
      'ghost-member',
    )
    await fs.writeFile(fixture.teamYamlPath, changedOutside, 'utf8')
    const teamStillThere = async () => {
      expect(existsSync(fixture.teamPath), 'the Team folder').toBe(true)
      expect(await fs.readFile(fixture.teamYamlPath, 'utf8')).toBe(changedOutside)
      expect(await fs.readFile(fixture.registryPath, 'utf8')).toBe(registryBefore)
    }

    // First confirmation, against the row as it was shown: refused.
    const firstDeletion = teamDeletion()
    await confirm.click()
    expect(
      (await firstDeletion).status(),
      'what the delete confirmed against the stale row was answered',
    ).toBe(409)
    await expect(refused).toBeVisible()
    await teamStillThere()

    // The same open confirmation still names the revision the person
    // confirmed, so pressing Yes again is refused again.
    const secondDeletion = teamDeletion()
    await confirm.click()
    expect(
      (await secondDeletion).status(),
      'what a second press on the same confirmation was answered',
    ).toBe(409)
    await expect(refused).toBeVisible()
    await teamStillThere()

    // Cancelled, the row is there, drawn from the Team as it now stands: its
    // health names the member added outside.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(teamRow(sidebar)).toHaveAccessibleDescription(
      /Agent 'ghost-member' names a persona file that is missing or unreadable\./,
    )
    await teamStillThere()

    // Deleted from that updated row, and only now.
    await openDeleteConfirmation()
    const thirdDeletion = teamDeletion()
    await confirm.click()
    expect(
      (await thirdDeletion).status(),
      'what the delete confirmed from the updated row was answered',
    ).toBeLessThan(300)
    await expect(dialog).toBeHidden()
    await expect.poll(() => existsSync(fixture.teamPath)).toBe(false)
    await expect(teamRow(sidebar)).toHaveCount(0)
    expect(await fs.readFile(fixture.registryPath, 'utf8')).not.toMatch(
      new RegExp(`^${TEAM_ID}:`, 'm'),
    )
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => provider.close(),
  ])
})

/**
 * Runs every teardown step even when an earlier one fails, then rethrows the
 * journey's own failure with any teardown errors beside it, never instead of
 * it.
 */
async function finishWithTeardown(
  primaryFailure: { readonly error: unknown } | undefined,
  steps: readonly (() => unknown)[],
): Promise<void> {
  const teardownErrors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      teardownErrors.push(error)
    }
  }
  if (primaryFailure && teardownErrors.length > 0) {
    throw new AggregateError(
      [primaryFailure.error, ...teardownErrors],
      'The journey failed, and so did its teardown',
    )
  }
  if (primaryFailure) throw primaryFailure.error
  if (teardownErrors.length > 0) {
    throw new AggregateError(teardownErrors, 'The journey passed, but its teardown failed')
  }
}
