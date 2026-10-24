import { readFileSync, writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const configuration = JSON.parse(readFileSync(0, 'utf8'))
const client = new Client({ name: 'question-provider-fixture', version: '1.0.0' })
process.once('SIGTERM', () => {
  writeFileSync(configuration.stoppedPath, readFileSync(configuration.requestPath, 'utf8'))
  process.exit(0)
})
await client.connect(new StreamableHTTPClientTransport(new URL(configuration.url), {
  requestInit: { headers: { authorization: `Bearer ${configuration.token}` } },
}), { timeout: 2_000 })
await client.callTool({
  name: configuration.toolName,
  arguments: {
    progress: 'I need the recipient to finish the dedication.',
    questions: [{ question: 'Who is the dedication for?', reason: 'The dedication needs a recipient.' }],
  },
}, undefined, { timeout: 2_000 })
// Reaching another turn is a defect: the host must stop this process at capture.
writeFileSync(configuration.continuedPath, 'The provider continued without an answer.')
await client.close()
