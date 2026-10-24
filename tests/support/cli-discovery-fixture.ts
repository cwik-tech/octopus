import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'

/** Real process/HTTP boundary: installed CLIs are nondeterministic and may use credentials. */
export async function createCliDiscoveryFixture(directory: string) {
  let model = 'saved-model'
  let held = false
  let notify = () => {}
  let probeCount = 0
  const pending: http.ServerResponse[] = []
  const answer = (response: http.ServerResponse) => response.end(JSON.stringify({
    subtype: 'get_available_models', models: [{ id: model, label: model }],
  }))
  const server = http.createServer((_request, response) => {
    probeCount += 1
    if (held) { pending.push(response); notify() }
    else answer(response)
  })
  server.requestTimeout = 10_000
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('CLI gate has no port')
  const bin = path.join(directory, 'bin')
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(path.join(bin, 'qwen.cjs'), `#!${process.execPath}
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('fixture-1'); process.exit(0); }
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  const message = JSON.parse(line);
  let response = {};
  if (message.request.subtype === 'get_available_models') {
    response = await (await fetch('http://127.0.0.1:${address.port}/models', { signal: AbortSignal.timeout(10000) })).json();
  }
  console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } }));
});
`, { mode: 0o700 })
  await fs.symlink('qwen.cjs', path.join(bin, 'qwen'))
  return {
    bin,
    probeCount: () => probeCount,
    hold() {
      held = true
      return new Promise<void>((resolve) => { notify = resolve })
    },
    release(nextModel = model) {
      model = nextModel
      held = false
      pending.splice(0).forEach(answer)
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

export function cliFixtureSettings() {
  return {
    version: 3, connections: [], cliEnabled: { qwen: true },
    cliModelEnabled: { qwen: { 'saved-model': true, 'new-model': true } },
    defaultModel: { provider: 'qwen', model: 'saved-model' },
  }
}
