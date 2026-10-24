import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import {
  buildToolRegistry,
  toolModules,
  type ToolDeps,
} from '../../server/tools/tool-registry.js'
import { researchWebToolModule } from '../../server/tools/research-web.js'
import { youtubeToolModule } from '../../server/tools/youtube.js'
import type { ResearchWebToolService } from '../../services/research-web-tool-service.js'

// The research module only allows loopback origins under a test environment,
// which is how it keeps that allowance out of a shipped build.
process.env.NODE_ENV = 'test'

test('the YouTube module is registered before the research module so the proxy port can be shared', () => {
  const youtube = toolModules.indexOf(youtubeToolModule)
  const researchWeb = toolModules.indexOf(researchWebToolModule)
  assert.ok(youtube >= 0 && researchWeb >= 0)
  assert.ok(
    youtube < researchWeb,
    'reordering these modules would silently disable the proxied retry',
  )
})

test('a registry that includes the YouTube module gives web research a working Webshare retry', async (context) => {
  const proxy = await startTunnelProxy()
  context.after(() => proxy.close())
  const origin = await startOrigin(proxy.proxyLocalPorts)
  context.after(() => origin.close())
  const fixture = await createWorkspace(context)

  const registry = buildToolRegistry(
    {
      workspacePath: fixture.workspacePath,
      repoRootPath: fixture.repoRootPath,
      moduleOptions: {
        youtube: {
          settingsOptions: {
            storagePath: path.join(fixture.root, 'youtube-settings.json'),
            environment: {
              WEBSHARE_USERNAME: 'loopback-user',
              WEBSHARE_PASSWORD: 'loopback-password',
              WEBSHARE_PROXY_HOST: '127.0.0.1',
              WEBSHARE_PROXY_PORT: String(proxy.port),
            },
          },
        },
        'research-web': { allowLoopbackSiteIcons: true },
      },
    } satisfies ToolDeps,
    [youtubeToolModule, researchWebToolModule],
  )

  const service = researchWebService(registry)
  assert.ok(service, 'the research module must build its tool service')

  const result = await service.execute(fixture.requestContext, 'call-wired', {
    action: 'acquire',
    url: `${origin.url}/denied-unless-proxied`,
    allowBrowserFallback: false,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.method, 'direct-http-proxied')
  assert.equal(proxy.connections, 1)
})

test('a registry without the YouTube module leaves web research on its unproxied path', async (context) => {
  const proxy = await startTunnelProxy()
  context.after(() => proxy.close())
  const origin = await startOrigin(proxy.proxyLocalPorts)
  context.after(() => origin.close())
  const fixture = await createWorkspace(context)

  const registry = buildToolRegistry(
    {
      workspacePath: fixture.workspacePath,
      repoRootPath: fixture.repoRootPath,
      moduleOptions: { 'research-web': { allowLoopbackSiteIcons: true } },
    } satisfies ToolDeps,
    [researchWebToolModule],
  )

  const service = researchWebService(registry)
  assert.ok(service)
  const result = await service.execute(fixture.requestContext, 'call-unwired', {
    action: 'acquire',
    url: `${origin.url}/denied-unless-proxied`,
    allowBrowserFallback: false,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'access_denied')
  assert.deepEqual(result.attempts?.map((attempt) => attempt.method), ['direct-http'])
  assert.equal(proxy.connections, 0)
})

// ---------------------------------------------------------------------------

function researchWebService(
  registry: readonly { readonly name: string; readonly services: Record<string, unknown> }[],
): ResearchWebToolService | undefined {
  const services = registry.find((entry) => entry.name === 'research-web')?.services
  const service = services?.researchWebToolService
  return service as ResearchWebToolService | undefined
}

const USABLE_BODY = `<!doctype html><html><head><title>Primary evidence</title></head><body><main>
<h1>Primary evidence</h1><p>${'This page carries enough readable prose to clear the acquisition quality threshold. '.repeat(6)}</p>
</main></body></html>`

async function startOrigin(
  proxyLocalPorts: ReadonlySet<number>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const proxied = proxyLocalPorts.has(request.socket.remotePort ?? -1)
    if (!proxied) {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>Forbidden</body></html>')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(USABLE_BODY)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))),
  }
}

async function startTunnelProxy(): Promise<{
  port: number
  connections: number
  proxyLocalPorts: ReadonlySet<number>
  close(): Promise<void>
}> {
  const proxyLocalPorts = new Set<number>()
  const sockets = new Set<net.Socket>()
  let connections = 0
  const server = http.createServer((_request, response) => response.writeHead(405).end())
  server.on('connect', (request, clientSocket: net.Socket, head: Buffer) => {
    connections += 1
    const [host, port] = (request.url ?? '').split(':')
    const upstream = net.connect({ host: host || '127.0.0.1', port: Number(port) }, () => {
      proxyLocalPorts.add(upstream.localPort ?? 0)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    sockets.add(upstream)
    sockets.add(clientSocket)
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    port: address.port,
    get connections() {
      return connections
    },
    proxyLocalPorts,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

async function createWorkspace(context: {
  after(callback: () => Promise<unknown> | unknown): unknown
}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'webshare-wiring-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const agentPath = 'agents/web-researcher'
  await fs.mkdir(path.join(repoRootPath, agentPath), { recursive: true })
  await fs.writeFile(
    path.join(repoRootPath, agentPath, 'web-researcher.md'),
    ['---', 'name: web-researcher', 'tools: read, research_web', '---', '', '# Web Researcher', ''].join('\n'),
  )
  const requestContext = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-wiring',
    leaseId: 'lease-wiring',
    sessionId: 'session-wiring',
    runId: 'run-wiring',
    assignmentId: 'assignment-wiring',
    activityScopeId: 'lane-wiring',
    agentPath,
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, requestContext)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  return { root, workspacePath, repoRootPath, requestContext }
}
