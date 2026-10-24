import { createServer } from 'node:http'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { expect, test as base, type TestInfo } from '@playwright/test'
import { launchDesktop } from './support/desktop-launch.js'

async function openHtmlCanvas(info: TestInfo) {
  const requests: string[] = []
  const blockedServer = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.end('Unexpected preview network access')
  })
  blockedServer.listen(0, '127.0.0.1')
  await once(blockedServer, 'listening')
  const address = blockedServer.address()
  if (!address || typeof address === 'string') throw new Error('Preview isolation server did not bind')
  const blockedUrl = `http://127.0.0.1:${address.port}`
  const source = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline'">
<base href="${blockedUrl}/"><script src="${blockedUrl}/script"></script>
</head><body>
<h1>Interactive sample</h1><button id="counter">Count 0</button><button id="isolation">Check isolation</button>
<output id="checks">Pending</output><a href="${blockedUrl}/navigation">Leave preview</a>
<a href="about:blank">Blank navigation</a><a href="data:text/html,untrusted">Data navigation</a>
<button id="wrapper">Load wrapper</button><button id="navigate">Navigate programmatically</button>
<form action="${blockedUrl}/form"><button>Submit form</button></form><iframe title="Nested escape" src="${blockedUrl}/nested"></iframe>
<script>
let count = 0;
document.getElementById('navigate').onclick = () => { location.href = '${blockedUrl}/script-navigation'; };
document.getElementById('wrapper').onclick = () => { location.href = new URL('canvas-preview.html', document.baseURI).href; };
document.getElementById('counter').onclick = () => { document.getElementById('counter').textContent = 'Count ' + (++count); };
document.getElementById('isolation').onclick = async () => {
  parent.postMessage({ kind: 'canvas-html-preview', content: '<h1>Untrusted child replacement</h1>' }, '*');
  const results = [typeof window.pipeline === 'undefined' ? 'desktop blocked' : 'desktop allowed'];
  try { parent.document.body.dataset.previewEscape = 'yes'; results.push('parent allowed'); } catch { results.push('parent blocked'); }
  try { localStorage.setItem('previewEscape', 'yes'); results.push('storage allowed'); } catch { results.push('storage blocked'); }
  try { top.location.href = '${blockedUrl}/top'; results.push('top allowed'); } catch { results.push('top blocked'); }
  results.push(window.open('${blockedUrl}/popup') === null ? 'popup blocked' : 'popup allowed');
  try { await fetch('${blockedUrl}/fetch'); results.push('fetch allowed'); } catch { results.push('fetch blocked'); }
  const image = new Image();
  const imageFinished = new Promise(resolve => { image.onload = () => resolve('image allowed'); image.onerror = () => resolve('image blocked'); });
  image.src = '${blockedUrl}/image';
  results.push(await imageFinished);
  document.getElementById('checks').textContent = results.join('; ');
};
</script></body></html>`
  // A delivered file is the starting condition. The session store, artifact,
  // local API, renderer and Chromium are real; no provider is needed to view it.
  const userDataPath = info.outputPath('user')
  const workspacePath = info.outputPath('workspace')
  try {
    const store = new FileSystemSessionStore(workspacePath)
    const session = await store.createSession({ title: 'Canvas HTML' })
    await store.appendChatMessage(session.id, {
      id: 'html-delivery', role: 'assistant', text: 'HTML sample ready.', createdAt: '2026-10-18T00:00:00.000Z',
      delivery: { taskId: 'html-task', artifacts: [{ runId: 'html-run', path: 'files/sample.html', role: 'final' }] },
    })
    const files = path.join(workspacePath, 'assignments', 'html-run', 'files')
    await fs.mkdir(files, { recursive: true })
    const artifactPath = path.join(files, 'sample.html')
    await fs.writeFile(artifactPath, source)
    const app = await launchDesktop({ userDataPath, workspacePath })
    try {
      const page = await app.firstWindow()
      const consoleMessages: string[] = []
      page.on('console', (message) => consoleMessages.push(message.text()))
      page.on('pageerror', (error) => consoleMessages.push(`Page error: ${error.message}`))
      await page.locator(`[data-session-id="${session.id}"]`).getByRole('button').first().click()
      await page.getByRole('region', { name: 'Run chat', exact: true }).getByRole('button', { name: 'Open full view', exact: true }).click()
      return { app, page, blockedServer, requests, source, artifactPath, consoleMessages }
    } catch (error) {
      await app.close()
      throw error
    }
  } catch (error) {
    await new Promise<void>((resolve, reject) => blockedServer.close((cause) => cause ? reject(cause) : resolve()))
    throw error
  }
}

const test = base.extend<{ journey: Awaited<ReturnType<typeof openHtmlCanvas>> }>({
  journey: [async ({}, use, info) => {
    const journey = await openHtmlCanvas(info)
    try { await use(journey) }
    finally {
      if (info.status !== info.expectedStatus) await info.attach('preview-diagnostics', { body: JSON.stringify({ frames: journey.page.frames().map((frame) => ({ url: frame.url(), name: frame.name() })), requests: journey.requests, console: journey.consoleMessages }, null, 2), contentType: 'application/json' })
      await journey.app.close()
      await new Promise<void>((resolve, reject) => journey.blockedServer.close((cause) => cause ? reject(cause) : resolve()))
    }
  }, { timeout: 60_000 }],
})

test('J4 generated HTML stays interactive and isolated while source view preserves its state', async ({ journey }, info) => {
  const { app, page, requests, source } = journey
  const canvas = page.getByRole('region', { name: 'Canvas workspace', exact: true })
  const preview = canvas.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')
  await expect(preview.getByRole('heading', { name: 'Interactive sample', exact: true })).toBeVisible()
  await preview.getByRole('button', { name: 'Count 0', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible()
  await canvas.getByRole('tab', { name: 'Source', exact: true }).click()
  expect(await canvas.getByLabel('HTML source').textContent()).toBe(source)
  await canvas.getByRole('tab', { name: 'Preview', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible()
  await preview.getByRole('button', { name: 'Check isolation', exact: true }).press('Enter')
  await expect(preview.locator('#checks')).toHaveText('desktop blocked; parent blocked; storage blocked; top blocked; popup blocked; fetch blocked; image blocked')
  await preview.getByRole('button', { name: 'Submit form', exact: true }).click()
  await preview.getByRole('link', { name: 'Leave preview', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible()
  await preview.getByRole('button', { name: 'Navigate programmatically', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible()
  await preview.getByRole('link', { name: 'Blank navigation', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible()
  await preview.getByRole('link', { name: 'Data navigation', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible()
  expect(await preview.locator('body').evaluate((element) => element.baseURI)).toContain('/canvas-preview.html')
  await preview.getByRole('button', { name: 'Load wrapper', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible()
  await expect(preview.getByRole('heading', { name: 'Interactive sample', exact: true })).toBeVisible()
  expect(requests).toEqual([])
  expect(app.windows()).toHaveLength(1)
  await expect(page.locator('body')).not.toHaveAttribute('data-preview-escape')
  await page.screenshot({ path: info.outputPath('canvas-html-preview.png') })
})

test('J5 a failed HTML refresh keeps the last interactive preview and its exact source', async ({ journey }, info) => {
  const { page, source, artifactPath } = journey
  const canvas = page.getByRole('region', { name: 'Canvas workspace', exact: true })
  const preview = canvas.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')
  await preview.getByRole('button', { name: 'Count 0', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible()
  // Delete only this journey's own generated fixture artifact. Refresh uses the
  // real loopback API and contained reader, rather than an intercepted failure.
  await fs.unlink(artifactPath)

  await canvas.getByRole('button', { name: 'Refresh', exact: true }).click()

  await expect(canvas.getByRole('alert')).toContainText('Showing the last loaded preview.')
  await expect(canvas.getByRole('alert')).toContainText('Preview unavailable')
  await expect(preview.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible()
  await canvas.getByRole('tab', { name: 'Source', exact: true }).click()
  expect(await canvas.getByLabel('HTML source').textContent()).toBe(source)
  await page.screenshot({ path: info.outputPath('canvas-html-stale-source.png') })
})
