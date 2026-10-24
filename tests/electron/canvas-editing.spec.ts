import { expect, test as base, type TestInfo } from '@playwright/test'
import * as fs from 'node:fs/promises'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { buildSessionRunAssignmentLocation, writeRunAssignmentLocator } from '../../domains/run/run-location.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { createFileTool } from '../../services/create-file-tool-service.js'
import { DEFAULT_JOURNAL_TENANT_ID } from '../../services/workspace-execution-journal-registry.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'
import { launchDesktop } from './support/desktop-launch.js'
import { seedProviderSettings } from './support/model-selection-fixture.js'

const original = '# Garden\n\nRoses bloom in summer.'

async function openDocument(info: TestInfo, historicalDelivery: boolean) {
  // The saved chat is arranged directly. Its file, artifact metadata and
  // accepted receipt come from the real leased capability runtime/journal.
  // Only paid model HTTP is replaced for the selected-text revision journey.
  const provider = await startOpenAiToolLoopFixture(process.cwd(), 'openai-tool-loop-server.mjs', {
    env: { PROVIDER_FANOUT_SCRIPT: JSON.stringify({ calls: [
      { id: 'garden-file', name: 'create_file', arguments: { filename: 'garden.md', content: original } },
    ], finalText: 'The garden document is ready.' }) },
  })
  const userDataPath = info.outputPath('user')
  const workspaceDirectory = info.outputPath('workspace')
  try {
    await fs.mkdir(workspaceDirectory, { recursive: true })
    const workspacePath = await fs.realpath(workspaceDirectory)
    await seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: { id: 'fixture/fanout', name: 'Canvas editor' }, models: [{ id: 'fixture/fanout', name: 'Canvas editor' }] })
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Canvas editing' })
    const identity = { sessionId: session.id, runId: 'garden-turn', assignmentId: 'garden-assignment' }
    const location = buildSessionRunAssignmentLocation(workspacePath, identity)
    if (!location) throw new Error('The file fixture must have a valid session assignment')
    await fs.mkdir(location.assignmentPath, { recursive: true })
    await writeRunAssignmentLocator(workspacePath, location)
    const leases = new McpRunLeaseStore()
    const lease = leases.issue({ ...identity, allowedAgentPaths: ['agents/general-agent'] })
    const runtime = new CapabilityDispatchRuntime({
      workspacePath, leaseResolver: (context) => leases.resolve(context),
      runtimeAuthority: { authorize: async () => { throw new Error('The file fixture requires its actual MCP lease authority') } },
      executionJournal: { mode: 'authoritative', tenantId: DEFAULT_JOURNAL_TENANT_ID },
    })
    const created = await (async () => {
      try {
        return await createFileTool({ workspacePath, dispatcher: runtime.dispatcher }).execute({
          context: { contractVersion: 1, ...identity, leaseId: lease.leaseId, requestId: 'garden-file-request', agentPath: 'agents/general-agent' },
          toolCallId: 'garden-file', input: { filename: 'garden.md', content: original }, signal: AbortSignal.timeout(5000),
        })
      } finally { await runtime.close(); leases.revoke(lease.leaseId) }
    })()
    expect(created.isError, created.content).toBe(false)
    const artifacts = created.artifacts
    if (!artifacts?.length) throw new Error('The real file tool must return its created artifact')
    const journal = await readExecutionJournal(location.assignmentPath)
    if (journal.kind !== 'ok') throw new Error(`The real file receipt is unavailable: ${journal.kind}`)
    expect(journal.events.some((event) => event.type === 'capability.dispatch.accepted')).toBe(true)
    await store.appendChatMessage(session.id, {
      id: 'garden-delivery', role: 'assistant', text: 'The garden document is ready.', createdAt: '2026-10-18T00:00:00.000Z',
      delivery: { taskId: identity.assignmentId, artifacts: artifacts.map((artifact) => {
        const delivered = { ...artifact, runId: identity.assignmentId }
        // Earlier chat records omitted only this field; retain the actual
        // accepted result and argument receipt instead of inventing a digest.
        if (historicalDelivery) Reflect.deleteProperty(delivered, 'digest')
        return delivered
      }) },
    })
    const app = await launchDesktop({ userDataPath, workspacePath })
    try {
      const page = await app.firstWindow()
      const chat = page.getByRole('region', { name: 'Run chat', exact: true })
      await page.locator(`[data-session-id="${session.id}"]`).getByRole('button').first().click()
      await expect(chat.getByText('The garden document is ready.', { exact: true })).toBeVisible()
      await chat.getByRole('button', { name: 'Open full view', exact: true }).click()
      const canvas = page.getByRole('region', { name: 'Canvas workspace', exact: true })
      await expect(canvas.getByRole('heading', { name: 'Garden', exact: true })).toBeVisible()
      return { app, page, canvas, provider }
    } catch (error) { await app.close(); throw error }
  } catch (error) { await provider.close(); throw error }
}

const test = base.extend<{ journey: Awaited<ReturnType<typeof openDocument>>; historicalDelivery: boolean }>({
  historicalDelivery: [false, { option: true }],
  journey: [async ({ historicalDelivery }, use, info) => {
    const journey = await openDocument(info, historicalDelivery)
    try { await use(journey) }
    finally { await journey.app.close(); await journey.provider.close() }
  }, { timeout: 60_000 }],
})

test('a Markdown working copy survives reopening while its original download stays unchanged', async ({ journey }, info) => {
  const { page, canvas } = journey
  const originalUrl = await canvas.getByRole('button', { name: 'Download garden.md', exact: true }).getAttribute('href')
  expect(originalUrl).toBeTruthy()
  await canvas.getByRole('button', { name: 'Edit Markdown', exact: true }).click()
  const editor = canvas.getByRole('textbox', { name: 'Markdown document', exact: true })
  await expect(editor).toHaveValue(original)
  await editor.fill('# Garden\n\nRoses and lilies bloom together.')
  await canvas.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(canvas.getByText('All changes saved', { exact: true })).toBeVisible()
  await canvas.getByRole('button', { name: 'Close garden.md', exact: true }).click()
  await expect(canvas.getByRole('tab', { name: 'garden.md', exact: true })).toHaveCount(0)
  await page.getByRole('region', { name: 'Run chat', exact: true }).getByRole('button', { name: 'Open full view', exact: true }).click()
  await expect(canvas.getByRole('textbox', { name: 'Markdown document', exact: true })).toHaveValue('# Garden\n\nRoses and lilies bloom together.')
  await expect(canvas.getByRole('tab', { name: 'garden.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  const downloaded = await page.request.get(originalUrl ?? '')
  expect(downloaded.status()).toBe(200)
  expect(await downloaded.text()).toBe(original)
  await page.screenshot({ path: info.outputPath('canvas-markdown-edited.png'), animations: 'disabled' })
})

test('a selected-text revision stays unchanged until accepted and discarded proposals never apply', async ({ journey }, info) => {
  const { page, canvas } = journey
  await canvas.getByRole('button', { name: 'Edit Markdown', exact: true }).click()
  const editor = canvas.getByRole('textbox', { name: 'Markdown document', exact: true })
  await expect(editor).toHaveValue(original)
  await editor.evaluate((node) => {
    if (!(node instanceof HTMLTextAreaElement)) throw new Error('The Markdown editor must support text selection')
    node.focus()
    node.setSelectionRange(10, 15)
    node.dispatchEvent(new Event('select', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange'))
  })
  await canvas.getByRole('textbox', { name: 'Revision instruction', exact: true }).fill('Replace the selected flower name.')
  await canvas.getByRole('button', { name: 'Request revision', exact: true }).click()
  await expect(canvas.getByLabel('Captured selection')).toHaveText('Roses')
  await expect(canvas.getByLabel('Proposed replacement')).toHaveText('provider-no-tools')
  await expect(editor).toHaveValue(original)
  await canvas.getByRole('button', { name: 'Discard revision', exact: true }).click()
  await expect(canvas.getByRole('button', { name: 'Accept revision', exact: true })).toHaveCount(0)
  await expect(editor).toHaveValue(original)
  await canvas.getByRole('button', { name: 'Request revision', exact: true }).click()
  await expect(canvas.getByLabel('Proposed replacement')).toHaveText('provider-no-tools')
  await canvas.getByRole('button', { name: 'Accept revision', exact: true }).click()
  await expect(editor).toHaveValue('# Garden\n\nprovider-no-tools bloom in summer.')
  await page.screenshot({ path: info.outputPath('canvas-reviewed-revision.png'), animations: 'disabled' })
})

test('a second view receives saved revisions while keeping its unsaved local draft', async ({ journey }, info) => {
  const { app, page, canvas } = journey
  await canvas.getByRole('button', { name: 'Edit Markdown', exact: true }).click()
  const editor = canvas.getByRole('textbox', { name: 'Markdown document', exact: true })
  await expect(editor).toHaveValue(original)
  const opening = app.waitForEvent('window')
  await page.getByRole('button', { name: 'Open in new window', exact: true }).click()
  const other = await opening
  await other.getByRole('region', { name: 'Run chat', exact: true }).getByRole('button', { name: 'Open full view', exact: true }).click()
  const otherCanvas = other.getByRole('region', { name: 'Canvas workspace', exact: true })
  const otherEditor = otherCanvas.getByRole('textbox', { name: 'Markdown document', exact: true })
  await expect(otherEditor).toHaveValue(original)
  await editor.fill('Keep this local draft.')
  await otherEditor.fill('# Garden\n\nA saved revision from the other view.')
  await otherCanvas.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(otherCanvas.getByText('All changes saved', { exact: true })).toBeVisible()
  await expect(canvas.getByText('A newer saved revision is available. Your draft has been kept.', { exact: true })).toBeVisible()
  await expect(editor).toHaveValue('Keep this local draft.')
  await canvas.getByRole('button', { name: 'Review saved revision', exact: true }).click()
  await expect(canvas.getByLabel('Current saved Markdown')).toHaveText('# Garden\n\nA saved revision from the other view.')
  await page.screenshot({ path: info.outputPath('canvas-draft-conflict.png'), animations: 'disabled' })
  await canvas.getByRole('button', { name: 'Discard local draft and use saved revision', exact: true }).click()
  await expect(editor).toHaveValue('# Garden\n\nA saved revision from the other view.')
  await other.close()
})

test.describe('earlier digestless file deliveries', () => {
  test.use({ historicalDelivery: true })

  test('the Original file pen edits an earlier Markdown output using its accepted creation receipt', async ({ journey }, info) => {
    const { page, canvas } = journey
    await page.screenshot({ path: info.outputPath('canvas-legacy-original-tools.png'), animations: 'disabled' })

    await canvas.getByRole('button', { name: 'Edit Markdown', exact: true }).click()

    const editor = canvas.getByRole('textbox', { name: 'Markdown document', exact: true })
    await expect(editor).toHaveValue(original)
    await editor.fill('# Garden\n\nEdited from an earlier verified creation.')
    await canvas.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(canvas.getByText('All changes saved', { exact: true })).toBeVisible()
    await expect(editor).toHaveValue('# Garden\n\nEdited from an earlier verified creation.')
    await page.screenshot({ path: info.outputPath('canvas-legacy-editing.png'), animations: 'disabled' })
  })
})
