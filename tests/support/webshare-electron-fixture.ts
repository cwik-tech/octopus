import { expect, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  WEBSHARE_API_KEY_ENV,
  WEBSHARE_PASSWORD_ENV,
  WEBSHARE_PROXY_COUNTRIES_ENV,
  WEBSHARE_PROXY_HOST_ENV,
  WEBSHARE_PROXY_PORT_ENV,
  WEBSHARE_USERNAME_ENV,
} from '../../domains/youtube/youtube-settings.js'
import { setFrontMatterFields } from './config-rewrite.js'

/**
 * The pieces the deterministic and live Webshare Electron journeys both need.
 *
 * Only what is genuinely shared lives here: the desktop project and settings
 * seeds, the Settings navigation, and the acquisition journal reader. The
 * journeys keep their own servers and assertions, because those are what each
 * one is about.
 */

// ---------------------------------------------------------------------------
// The persisted acquisition journal
// ---------------------------------------------------------------------------

export interface AcquisitionAttemptRecord {
  readonly method?: string
  readonly outcome?: string
}

export interface AcquisitionRecord {
  readonly action?: string
  readonly state?: string
  readonly requestedUrl?: string
  readonly canonicalUrl?: string
  readonly attempts?: readonly AcquisitionAttemptRecord[]
  readonly observationReceipt?: { readonly method?: string }
}

/**
 * Validates the fields the journeys assert on rather than casting.
 *
 * A journal that does not match the shape the assertions rely on is refused
 * here, where the reason is obvious, instead of surfacing later as an
 * unexplained `undefined` in an expectation.
 */
export function parseAcquisitionJournal(raw: string): readonly AcquisitionRecord[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error('Acquisition journal is not an array of records.')
  }
  return parsed.map((entry: unknown, index) => {
    if (!isUnknownRecord(entry)) {
      throw new Error(`Acquisition journal entry ${index} is not an object.`)
    }
    const record: {
      action?: string
      state?: string
      requestedUrl?: string
      canonicalUrl?: string
      attempts?: AcquisitionAttemptRecord[]
      observationReceipt?: { method?: string }
    } = {}

    const action = optionalString(entry, 'action', index)
    if (action !== undefined) record.action = action
    const state = optionalString(entry, 'state', index)
    if (state !== undefined) record.state = state
    const requestedUrl = optionalString(entry, 'requestedUrl', index)
    if (requestedUrl !== undefined) record.requestedUrl = requestedUrl
    const canonicalUrl = optionalString(entry, 'canonicalUrl', index)
    if (canonicalUrl !== undefined) record.canonicalUrl = canonicalUrl

    const attempts = entry.attempts
    if (attempts !== undefined) {
      if (!Array.isArray(attempts)) {
        throw new Error(`Acquisition journal entry ${index} has a non-array 'attempts'.`)
      }
      record.attempts = attempts.map((attempt: unknown) => {
        if (!isUnknownRecord(attempt)) {
          throw new Error(`Acquisition journal entry ${index} has a non-object attempt.`)
        }
        const parsedAttempt: { method?: string; outcome?: string } = {}
        const method = optionalString(attempt, 'method', index)
        if (method !== undefined) parsedAttempt.method = method
        const outcome = optionalString(attempt, 'outcome', index)
        if (outcome !== undefined) parsedAttempt.outcome = outcome
        return parsedAttempt
      })
    }

    const receipt = entry.observationReceipt
    if (receipt !== undefined) {
      if (!isUnknownRecord(receipt)) {
        throw new Error(`Acquisition journal entry ${index} has a non-object receipt.`)
      }
      const method = optionalString(receipt, 'method', index)
      record.observationReceipt = method === undefined ? {} : { method }
    }

    return record
  })
}

/** An object that is not an array, so indexed reads mean what they say. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  index: number,
): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`Acquisition journal entry ${index} field '${key}' is not a string.`)
  }
  return value
}

/** Every settled acquisition the app has journalled for this workspace. */
export async function readSettledAcquisitions(
  workspacePath: string,
): Promise<readonly AcquisitionRecord[]> {
  const sessions = path.join(workspacePath, 'sessions')
  let entries: string[]
  try {
    entries = await fs.readdir(sessions)
  } catch (error) {
    // Only "the app has not written any session yet" is expected here.
    if (isMissingFile(error)) return []
    throw error
  }
  const settled: AcquisitionRecord[] = []
  for (const entry of entries) {
    const journalPath = path.join(sessions, entry, 'research-acquisition.json')
    let raw: string
    try {
      raw = await fs.readFile(journalPath, 'utf8')
    } catch (error) {
      // A session directory without a journal yet is expected while a turn is
      // still starting. Anything else is not, and must not be swallowed.
      if (isMissingFile(error)) continue
      throw error
    }
    // A malformed or unexpected journal is a real failure. Swallowing it here
    // would turn corruption into an unexplained poll timeout.
    let rows: readonly AcquisitionRecord[]
    try {
      rows = parseAcquisitionJournal(raw)
    } catch (error) {
      throw new Error(
        `Unreadable acquisition journal at ${journalPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    for (const row of rows) {
      if (row.action === 'acquire' && row.state !== 'running') settled.push(row)
    }
  }
  return settled
}

function isMissingFile(error: unknown): boolean {
  return isUnknownRecord(error) && error.code === 'ENOENT'
}

// ---------------------------------------------------------------------------
// Desktop environment and seeds
// ---------------------------------------------------------------------------

/**
 * A developer's own Webshare variables would take over the settings panel
 * through `hasEnvironmentOverride` and disable every control. Empty values
 * keep the panel writable and also stop the API server's `.env` loader from
 * restoring the developer's credentials after Electron starts.
 */
export function withoutWebshareEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...environment }
  for (const key of [
    WEBSHARE_API_KEY_ENV,
    WEBSHARE_USERNAME_ENV,
    WEBSHARE_PASSWORD_ENV,
    WEBSHARE_PROXY_HOST_ENV,
    WEBSHARE_PROXY_PORT_ENV,
    WEBSHARE_PROXY_COUNTRIES_ENV,
  ]) {
    copy[key] = ''
  }
  return copy
}

export async function createWebResearcherProject(
  repoRoot: string,
  projectRoot: string,
): Promise<void> {
  const agentDirectory = path.join(projectRoot, 'agents', 'web-researcher')
  const personaPath = path.join(
    repoRoot,
    'agents',
    'web-researcher',
    'web-researcher.md',
  )
  // Set, not replace: the bundled persona may legitimately stop declaring
  // either field, and this journey still has to dispatch to the fixture.
  const fixturePersona = setFrontMatterFields({
    fields: { model: 'fixture/research-web', provider: 'openai' },
    file: personaPath,
    source: await fs.readFile(personaPath, 'utf8'),
  })
  await fs.mkdir(agentDirectory, { recursive: true })
  await fs.writeFile(path.join(agentDirectory, 'web-researcher.md'), fixturePersona, 'utf8')
  await fs.cp(
    path.join(repoRoot, 'agents', 'web-researcher', 'skills', 'web-research'),
    path.join(agentDirectory, 'skills', 'web-research'),
    { recursive: true },
  )
}

export async function seedAcquisitionSettings(userDataPath: string): Promise<void> {
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(
    path.join(userDataPath, 'research-acquisition-settings.json'),
    JSON.stringify({
      schemaVersion: 2,
      providerPriority: ['brave', 'exa'],
      providers: {
        exa: { enabled: false, status: 'unknown' },
        brave: { enabled: true, status: 'connected' },
        firecrawl: { enabled: false, status: 'unknown' },
      },
      budgets: {
        maximumSearchCalls: 20,
        maximumBrowserFallbacks: 10,
        maximumManagedReaderCalls: 5,
        maximumModelExtractions: 20,
      },
      extractionModel: null,
    }),
    'utf8',
  )
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export async function configureModelProvider(
  page: Page,
  providerUrl: string,
  providerSecret: string,
): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByLabel('Connection type').selectOption('openai-compatible')
  await page.getByLabel('Name').fill('Web Researcher Fixture')
  await page.getByLabel('Base URL').fill(`${providerUrl}/v1`)
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill(providerSecret)
  await page.getByRole('button', { name: 'Save & Validate' }).click()
  await page.getByRole('button', { name: /^Web Researcher Fixture/ }).click()
  await page.getByRole('switch', { name: 'Enable fixture/research-web' }).click()
  await page.getByLabel('Default model').click()
  const modelDialog = page.getByRole('dialog', { name: 'Select model' })
  await modelDialog.getByPlaceholder('Search models...').fill('fixture/research-web')
  await modelDialog.getByText('fixture/research-web', { exact: true }).click()
  await page.getByRole('button', { name: 'Close' }).click()
}

export async function openWebshareSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Research & Acquisition', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Webshare residential proxy' }),
  ).toBeVisible({ timeout: 30_000 })
}

export async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(
    page.getByRole('navigation', { name: 'Settings sections' }),
  ).toHaveCount(0, { timeout: 30_000 })
}

export async function selectWebResearcher(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click()
  await page.getByRole('button', { name: 'Search Agents' }).click()
  await page.getByRole('searchbox', { name: 'Search Agents' }).fill('web-researcher')
  await page.getByRole('button', { name: /^Web Researcher/i }).click()
}

/** The agent stays selected between turns, so only the first run picks it. */
export async function sendToWebResearcher(page: Page, message: string): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click()
  await page.getByPlaceholder('Send a message to the selected agents...').fill(message)
  await page.getByRole('button', { name: 'Send message' }).click()
}
