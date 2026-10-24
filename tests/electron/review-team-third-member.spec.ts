/**
 * A review is two people: one writes, the other checks.
 *
 * A third has no role in it — the engine dispatches exactly a producer and a
 * reviewer — so adding one would produce a team with a member who never runs.
 * The refusal is enforced where the team is written, and this is the part the
 * user meets: the dialog they use, the words they are given, and the file they
 * still have afterwards.
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  desktopEnvironment,
  repoRoot,
  writeAgentPersona,
} from './support/model-selection-fixture.js'

const TEAM_ID = 'clause-review'
const PRODUCER = 'clause-writer'
const REVIEWER = 'clause-checker'
const OUTSIDER = 'clause-observer'

interface Paths {
  projectRoot: string
  userDataPath: string
  workspacePath: string
}

/** A saved review team of exactly two, as the builder emits one. */
async function seedReviewTeam(
  outputPath: (name: string) => string,
): Promise<Paths> {
  const projectRoot = outputPath('review-third-project')
  const userDataPath = outputPath('review-third-user-data')
  const workspacePath = outputPath('review-third-workspace')
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(path.join(projectRoot, 'teams', TEAM_ID), { recursive: true }),
  ])
  for (const name of [PRODUCER, REVIEWER, OUTSIDER]) {
    await writeAgentPersona(projectRoot, {
      name,
      description: `${name} persona.`,
      marker: `You are ${name}`,
    })
  }
  await fs.writeFile(
    path.join(projectRoot, 'teams.yaml'),
    [
      `${TEAM_ID}:`,
      '  type: team',
      '  description: Drafts a clause summary and has it checked.',
      `  team_path: ./teams/${TEAM_ID}`,
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(projectRoot, 'teams', TEAM_ID, 'team.yaml'),
    [
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: Drafts a clause summary and has it checked.',
      '  version: "0.1.0"',
      '  created_by: "team-builder"',
      '  created_by_orchestrator: "plan-1"',
      '  published_by: "plan-1@sha256:one"',
      '',
      'workspace:',
      '  path: ../../workspace',
      '  watch: false',
      '',
      'workflow:',
      '  entry_level: setup',
      '  invocation_modes:',
      '    - user',
      '  user_facing: true',
      '  output_contract:',
      '    artifacts:',
      '      - path: "final-result.md"',
      '        required: true',
      '        description: Final result produced by the generated team.',
      '    completion_artifact: "final-result.md"',
      '',
      'agents:',
      `  - name: "${PRODUCER}"`,
      '    type: agent',
      '    role: Writer.',
      '    tools: []',
      `    agent_file: "../../agents/${PRODUCER}/${PRODUCER}.md"`,
      `  - name: "${REVIEWER}"`,
      '    type: agent',
      '    role: Checker.',
      '    tools: []',
      `    agent_file: "../../agents/${REVIEWER}/${REVIEWER}.md"`,
      '',
      'levels:',
      '  - id: setup',
      '    name: Setup',
      '    order: 0',
      '    stage:',
      '      type: review',
      `      producer: "${PRODUCER}"`,
      `      reviewer: "${REVIEWER}"`,
      '      config:',
      '        max_iterations: 1',
      '        on_max_iterations: escalate_to_user',
      '        output:',
      '          format: "final-result.md"',
      '          user_review: false',
      '',
      'gates:',
      '  - from: setup',
      '    to: done',
      '    condition:',
      '      type: artifact_exists',
      '      artifact: "final-result.md"',
      '',
    ].join('\n'),
    'utf8',
  )
  return { projectRoot, userDataPath, workspacePath }
}

async function openSavedTeam(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  await page
    .getByLabel('Resource type')
    .getByRole('tab', { name: 'Teams', exact: true })
    .click()
  const entry = page
    .getByRole('button', { name: new RegExp('^Clause Review\\b') })
    .first()
  await expect(entry).toBeVisible({ timeout: 60_000 })
  await entry.click()
  await expect(page.locator('[data-slot="team-roster-editor"]')).toBeVisible({
    timeout: 60_000,
  })
}

test('a third member cannot be added to a review team, and the user is told why', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const paths = await seedReviewTeam((name) => testInfo.outputPath(name))
  const teamYamlPath = path.join(paths.projectRoot, 'teams', TEAM_ID, 'team.yaml')
  const before = await fs.readFile(teamYamlPath, 'utf8')

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: desktopEnvironment(paths),
  })
  try {
    const page = await app.firstWindow()
    await openSavedTeam(page)

    await page
      .locator('[data-slot="team-roster-editor"]')
      .getByRole('button', { name: 'Add agent' })
      .click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Clause Observer' }).click()
    await dialog.getByRole('button', { name: 'Add' }).click()

    // Refused where the user is: in the dialog they are still looking at, in
    // words they can act on. A message behind the modal is not an answer.
    await expect(
      dialog.getByText(/A review team is one writer and one checker/i),
    ).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByText(/Clause Observer/i)).toBeVisible()

    // And the team is exactly as it was, on screen and on disk.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await expect(
      page
        .locator('[data-slot="team-roster-editor"]')
        .getByRole('listitem'),
    ).toHaveCount(2)
    expect(await fs.readFile(teamYamlPath, 'utf8')).toBe(before)
  } finally {
    await app.close()
  }
})
