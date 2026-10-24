/**
 * Desktop fixture for the model-selection journeys.
 *
 * The product rule these journeys exercise has exactly two configuration
 * sources: an Agent's own provider/model pair, or the one application-wide
 * default from Settings. Every fixture here is built to keep those two sources
 * *distinguishable on sight*, which is what makes the assertions meaningful:
 *
 * - The connection id carries no hyphens, so the roster preview's provider
 *   label (`formatProvider` title-cases each hyphen-separated part) is a stable
 *   literal a test can state independently rather than recompute.
 * - Every model id is unique and appears nowhere else in the fixture, so a
 *   request seen by the fake provider identifies which selection produced it
 *   without any positional guessing.
 * - No agent, team, or default ever shares a pair with another one. A test that
 *   passed because two selections happened to coincide would prove nothing.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fixtureDesktopEnvironment } from '../../support/desktop-journey-environment.js'

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
)

/**
 * Deliberately hyphen-free.
 *
 * The Create roster preview renders the provider through `formatProvider`,
 * which title-cases each `-`-separated segment. A hyphenated id would force a
 * test to reimplement that transformation to state its expectation, which is
 * exactly the "expected value computed by the production algorithm" trap.
 */
export const FIXTURE_CONNECTION_ID = 'fixtureconnection'
export const FIXTURE_PROVIDER = `connection:${FIXTURE_CONNECTION_ID}`
/** What the Create roster preview shows for `FIXTURE_PROVIDER`. */
export const FIXTURE_PROVIDER_LABEL = 'Connection:fixtureconnection'

export interface FixtureModel {
  readonly id: string
  readonly name: string
  /**
   * The effort levels this model reports, as a provider's own listing would.
   *
   * Seeded rather than discovered because these journeys are not about model
   * discovery; what matters is that the editor offers what the catalogue says
   * and the dispatched request carries what was chosen.
   */
  readonly supportedEfforts?: readonly string[]
}

export const APP_DEFAULT_MODEL: FixtureModel = {
  id: 'fake/app-default',
  name: 'Fake App Default',
}
export const REPLACEMENT_DEFAULT_MODEL: FixtureModel = {
  id: 'fake/replacement-default',
  name: 'Fake Replacement Default',
}
export const ANALYST_MODEL: FixtureModel = {
  id: 'fake/analyst-pinned',
  name: 'Fake Analyst Pinned',
}
export const EDITOR_MODEL: FixtureModel = {
  id: 'fake/editor-pinned',
  name: 'Fake Editor Pinned',
}

export const ALL_FIXTURE_MODELS: readonly FixtureModel[] = [
  APP_DEFAULT_MODEL,
  REPLACEMENT_DEFAULT_MODEL,
  ANALYST_MODEL,
  EDITOR_MODEL,
]

/**
 * Writes `provider-settings.json` the way Settings → AI Providers would.
 *
 * Seeded rather than typed through the Settings form because none of these
 * journeys is about *adding* a connection — that has its own coverage. What
 * matters is that the runtime, the authoring UI, and the roster preview all
 * read the same one default from the same file.
 */
export async function seedProviderSettings(params: {
  userDataPath: string
  baseUrl: string
  models?: readonly FixtureModel[]
  /** Omit to leave the application default unset. */
  defaultModel?: FixtureModel
  /**
   * The seeded connection has no key. `lm-studio` allows that on the native
   * tool route every Agent chat turn now takes; `openai-compatible`, the
   * default, is refused there without a key.
   */
  kind?: 'openai-compatible' | 'lm-studio'
}): Promise<void> {
  const models = params.models ?? ALL_FIXTURE_MODELS
  await fs.mkdir(params.userDataPath, { recursive: true })
  await fs.writeFile(
    path.join(params.userDataPath, 'provider-settings.json'),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: FIXTURE_CONNECTION_ID,
          kind: params.kind ?? 'openai-compatible',
          name: 'Fake selection provider',
          baseUrl: `${params.baseUrl}/v1`,
          enabled: true,
          status: 'connected',
          models: models.map((model) => ({
            id: model.id,
            name: model.name,
            enabled: true,
            capabilities: ['chat'],
            ...(model.supportedEfforts
              ? { supportedEfforts: [...model.supportedEfforts] }
              : {}),
          })),
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
      ...(params.defaultModel
        ? {
            defaultModel: {
              provider: FIXTURE_PROVIDER,
              model: params.defaultModel.id,
            },
          }
        : {}),
    }),
    'utf8',
  )
}

export interface FixtureAgent {
  readonly name: string
  readonly description: string
  /** A phrase unique to this persona, used to attribute provider requests. */
  readonly marker: string
  /** Omit both to leave the Agent in app-default mode. */
  readonly provider?: string
  readonly model?: string
  readonly tier?: string
  /**
   * The level the persona names, or `null` to name none at all.
   *
   * Absence is a state of its own: it is how an Agent follows the application
   * default, and a journey about the effort control has to be able to start
   * from it.
   */
  readonly thinking?: string | null
}

/**
 * Writes one Agent persona into the project library.
 *
 * App-default mode is the *absence* of the fields, never a copy of today's
 * default — that absence is what keeps the Agent inheriting after the default
 * changes, so the fixture has to express it the same way the editor does.
 */
export async function writeAgentPersona(
  projectRoot: string,
  agent: FixtureAgent,
): Promise<void> {
  const directory = path.join(projectRoot, 'agents', agent.name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, `${agent.name}.md`),
    [
      '---',
      `name: ${agent.name}`,
      `description: ${agent.description}`,
      `tier: ${agent.tier ?? 'strategic'}`,
      ...(agent.provider ? [`provider: ${agent.provider}`] : []),
      ...(agent.model ? [`model: ${agent.model}`] : []),
      ...(agent.thinking === null ? [] : [`thinking: ${agent.thinking ?? 'low'}`]),
      '---',
      '',
      `# ${agent.name}`,
      '',
      // The marker travels in the system prompt, which is what lets a test say
      // which Agent produced a given provider request without relying on
      // arrival order. Order is not a safe key here: one logical reply can
      // produce more than one request.
      agent.marker,
      '',
      'Answer the question in one short sentence.',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * The environment a desktop journey needs to run fully offline.
 *
 * It starts from `fixtureDesktopEnvironment`, which keeps only the runner's
 * operational values, a PATH with no provider CLI in it and no fallback
 * directories, so the app cannot reach a real CLI, key or runtime route. A
 * journey that needs a fixture key or endpoint adds it after this. A journey
 * that wants a narrower PATH passes it in `inherited`, so the guard still
 * filters it rather than the journey overriding the guard's PATH afterwards.
 */
export function desktopEnvironment(
  paths: {
    projectRoot: string
    userDataPath: string
    workspacePath: string
  },
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...fixtureDesktopEnvironment(inherited),
    NODE_ENV: 'test',
    PIPELINE_DESKTOP_E2E: '1',
    PIPELINE_DESKTOP_PROJECT_ROOT: paths.projectRoot,
    PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
    PIPELINE_DESKTOP_USER_DATA: paths.userDataPath,
    PIPELINE_DESKTOP_WORKSPACE_PATH: paths.workspacePath,
  }
}
