import { _electron as electron, expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { desktopEnvironment, repoRoot, writeAgentPersona } from './support/model-selection-fixture.js'

async function progressFixture(root: string) {
  const pending = new Map<string, http.ServerResponse[]>()
  const released = new Set<string>()
  const server = http.createServer((request, response) => {
    const key = request.url ?? ''
    if (released.has(key)) response.end()
    else pending.set(key, [...(pending.get(key) ?? []), response])
  })
  server.requestTimeout = 20_000
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const bin = path.join(root, 'bin')
  await fs.mkdir(bin, { recursive: true })
  // Paid, nondeterministic Claude is replaced only at its subprocess boundary.
  await fs.writeFile(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.307 (Claude Code)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--mcp-config --setting-sources --disable-slash-commands --strict-mcp-config --tools --allowedTools --permission-mode'); process.exit(0); }
const emit = event => process.stdout.write(JSON.stringify(event)+'\\n');
if (!process.argv.includes('--system-prompt-file')) {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line);
    emit({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{models:[{value:'opus',displayName:'Fixture Opus'}]}}});
  });
} else {
process.stdin.resume();
process.stdin.on('end', async () => {
  emit({type:'system',subtype:'init'});
  emit({type:'rate_limit_event',rate_limit_info:{status:'allowed'}});
  emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}});
  emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'PRIVATE_REASONING_NEVER_DISPLAY'}}});
  await fetch('http://127.0.0.1:${address.port}/retry',{signal:AbortSignal.timeout(20000)});
  emit({type:'system',subtype:'api_retry',attempt:2,max_retries:5,retry_delay_ms:30000,error_status:503,error:'server_error'});
  await fetch('http://127.0.0.1:${address.port}/finish',{signal:AbortSignal.timeout(20000)});
  emit({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'The calendar update is ready.'}}});
  emit({type:'result',subtype:'success',is_error:false,result:'The calendar update is ready.',usage:{input_tokens:10,output_tokens:8},total_cost_usd:0});
});
}
`, { mode: 0o700 })
  return {
    bin,
    release(key: string) { released.add(key); pending.get(key)?.forEach(response => response.end()); pending.delete(key) },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

test('CLI activity and retries survive reopening the chat and disappear after the saved answer', async ({}, info) => {
  const root = info.outputPath('progress')
  const projectRoot = path.join(root, 'project')
  const workspacePath = path.join(root, 'workspace')
  const userDataPath = path.join(root, 'user')
  const fixture = await progressFixture(root)
  await writeAgentPersona(projectRoot, { name: 'general-agent', tier: 'orchestration', description: 'Progress fixture', marker: 'Answer the question.', provider: 'claude', model: 'opus' })
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(path.join(userDataPath, 'provider-settings.json'), JSON.stringify({
    version: 3, connections: [], cliEnabled: { claude: true }, cliModelEnabled: { claude: { opus: true } }, defaultModel: { provider: 'claude', model: 'opus' },
  }))
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Progress journey' })
  const environment = desktopEnvironment({ projectRoot, workspacePath, userDataPath })
  environment.PATH = `${fixture.bin}${path.delimiter}${environment.PATH ?? ''}`
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: environment })
  try {
    const page = await app.firstWindow()
    const sessionRow = page.locator(`[data-session-id="${session.id}"]`).getByRole('button', { name: /^Progress journey\b/ })
    await sessionRow.click()
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    await expect(chat.getByRole('button', { name: 'Edit session title', exact: true })).toHaveText('Progress journey')
    await chat.getByRole('textbox').fill('Update the calendar')
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
    const progress = chat.getByRole('button', { name: /Agent progress: Thinking/ })
    await expect(progress).toBeVisible({ timeout: 8000 })
    await expect(chat).not.toContainText('PRIVATE_REASONING_NEVER_DISPLAY')
    await expect(chat).not.toContainText('Rate limited')
    fixture.release('/retry')
    await expect(chat.getByRole('button', { name: /Agent progress: Provider retry 2/ })).toBeVisible()
    const opened = app.waitForEvent('window')
    await page.getByRole('button', { name: 'Open in new window', exact: true }).click()
    const observer = await opened
    const observedChat = observer.getByRole('region', { name: 'Run chat', exact: true })
    await expect(observedChat.getByRole('button', { name: /Agent progress: Provider retry 2/ })).toBeVisible()
    await observer.reload()
    await expect(observedChat.getByRole('button', { name: /Agent progress: Provider retry 2/ })).toBeVisible()
    await observedChat.getByRole('button', { name: /Agent progress:/ }).click()
    await expect(observedChat.getByText('Recent activity', { exact: true })).toBeVisible()
    await observer.screenshot({ path: info.outputPath('retry-progress.png') })
    fixture.release('/finish')
    await expect(chat.getByText('The calendar update is ready.', { exact: true })).toBeVisible()
    await expect(chat.getByRole('button', { name: /Agent progress:/ })).toHaveCount(0)
    expect((await store.listChatMessages(session.id)).filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['The calendar update is ready.'])
  } finally {
    fixture.release('/retry'); fixture.release('/finish')
    await app.close()
    await fixture.close()
  }
})
