/**
 * O1 — the visible streaming journey.
 *
 * Drives the path a user can actually reach: a configured connection, which is
 * what the chat model catalog offers. It is an LM Studio connection because
 * that kind needs no API key, and the native tool route refuses a keyless
 * OpenAI-compatible one. The provider is a
 * local fake on a random port, so the stream is deterministic and no network or
 * installed CLI is involved.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const CONNECTION_ID = '11111111-2222-3333-4444-555555555555'
const MODEL_ID = 'fake/streaming'

async function seedProviderSettings(
  userDataPath: string,
  baseUrl: string,
): Promise<void> {
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(
    path.join(userDataPath, 'provider-settings.json'),
    JSON.stringify({
      version: 1,
      // No encrypted key: the fake provider needs no credential, and the
      // desktop secret codec is not reachable from the test process. An
      // `openai-compatible` connection requires a key on the native tool
      // route every Agent now takes, so the keyless connection is the kind
      // that allows none.
      connections: [
        {
          id: CONNECTION_ID,
          kind: 'lm-studio',
          name: 'Fake streaming provider',
          baseUrl: `${baseUrl}/v1`,
          enabled: true,
          status: 'connected',
          models: [
            { id: MODEL_ID, name: 'Fake Streaming', enabled: true, capabilities: ['chat'] },
          ],
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
      defaultModel: { provider: `connection:${CONNECTION_ID}`, model: MODEL_ID },
    }),
    'utf8',
  )
}

test('chat text grows while the turn is running, then matches the saved reply', async ({}, testInfo) => {
  test.setTimeout(90_000)

  // One gate per suffix, so growth is observed step by step rather than
  // inferred from the finished sentence.
  const releases: Array<() => void> = []
  const deltaGates = ['first', 'second', 'third'].map(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve)
      }),
  )
  let releaseTerminal: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseTerminal = resolve
  })
  const releaseAll = () => {
    for (const release of releases) release()
    releaseTerminal()
  }
  // Every Agent has `create_file`, so the turn runs the native tool loop: a
  // buffered tool-capable round first, then the tool-free final request that
  // streams the answer. Only the final request is gated. The first round's
  // draft is never shown.
  const provider = await startFakeChatCompletionsServer({
    script: [
      { match: (request) => !request.stream, content: 'Draft reply, never shown.' },
      {
        match: (request) => request.stream && request.body.tool_choice === 'none',
        deltas: ['Kestrel ', 'Marlin ', 'Quokka'],
        deltaGates,
        gate,
      },
    ],
  })

  const workspacePath = testInfo.outputPath('streaming-workspace')
  const projectRoot = testInfo.outputPath('streaming-project')
  const userDataPath = testInfo.outputPath('streaming-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(path.join(projectRoot, 'agents', 'delta'), { recursive: true }).then(() =>
      fs.writeFile(
        path.join(projectRoot, 'agents', 'delta', 'delta.md'),
        [
          '---',
          'name: delta',
          'description: Streaming journey fixture agent.',
          'tier: strategic',
          `provider: connection:${CONNECTION_ID}`,
          `model: ${MODEL_ID}`,
          'thinking: low',
          '---',
          '',
          '# delta',
          '',
          'Answer the question.',
          '',
        ].join('\n'),
        'utf8',
      ),
    ),
    seedProviderSettings(userDataPath, provider.url),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Delta Journey' })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: /^Delta Journey\b/ }).first().click()

    // Addressed to one Agent: this journey is about an Agent's reply
    // streaming, and an untargeted turn is the Run Coordinator's now.
    const composer = page.getByRole('textbox').last()
    await composer.click()
    await composer.pressSequentially('@delta')
    await expect(
      page.getByRole('listbox', { name: 'Agent mentions' }),
    ).toBeVisible({ timeout: 15_000 })
    await composer.press('Enter')
    await composer.pressSequentially(' Say something')
    await page.keyboard.press('Enter')

    // Scope to the transcript: the session title and the model picker also
    // contain words, and a bare text match would collide with them.
    const log = page.getByRole('region', { name: 'Run chat' }).getByRole('log')

    // First suffix only. The POST has not returned, so this can only be the
    // stream.
    releases[0]?.()
    await expect(log.getByText(/Kestrel/)).toBeVisible({ timeout: 30_000 })
    await expect(log.getByText(/Marlin/)).toHaveCount(0)

    // Second suffix: the same bubble is longer than it was.
    releases[1]?.()
    await expect(log.getByText(/Kestrel Marlin/)).toBeVisible({ timeout: 30_000 })
    await expect(log.getByText(/Quokka/)).toHaveCount(0)

    // Third suffix completes the sentence, still mid-turn.
    releases[2]?.()
    await expect(log.getByText(/Kestrel Marlin Quokka/)).toBeVisible({
      timeout: 30_000,
    })

    // Let the turn finish; the durable reply replaces the preview.
    releaseTerminal()
    await expect(log.getByText('Kestrel Marlin Quokka')).toBeVisible({
      timeout: 30_000,
    })

    // The saved transcript agrees with what was on screen.
    await expect
      .poll(
        async () => {
          const messages = await sessionStore.listChatMessages(session.id)
          return messages.find((message) => message.role === 'assistant')?.text
        },
        { timeout: 30_000 },
      )
      .toBe('Kestrel Marlin Quokka')
    await expect(log.getByText(/Draft reply/)).toHaveCount(0)
  } finally {
    releaseAll()
    await app.close()
    await provider.close()
  }
})
