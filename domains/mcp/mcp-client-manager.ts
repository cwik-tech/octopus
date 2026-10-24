import { whenDefined } from '../../core/optional-properties.js'
import { execFileSync, spawnSync } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ElicitRequestSchema,
  ErrorCode,
  McpError,
  type ElicitRequest,
  type ElicitResult,
  type Progress,
} from '@modelcontextprotocol/sdk/types.js'

import {
  classifyMcpToolRisk,
  mcpToolRequiresApproval,
  namespaceMcpToolName,
  resolveMcpCapabilityEffect,
  type McpJsonObject,
  type McpJsonSchema,
  type McpNamespacedTool,
  type McpBrokerRequestContext,
  type McpSanitizedErrorCode,
} from './mcp-runtime.js'
import type {
  McpNegotiatedCapabilities,
  McpServerSettings,
} from './mcp-settings.js'
import { ExactOptionalMcpTransport } from './mcp-transport-adapter.js'

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
const MAX_DISCOVERY_PAGES = 100
const MAX_CAPTURED_PROCESS_COUNT = 4_096
const PROCESS_TREE_QUERY_TIMEOUT_MS = 1_000

export interface McpConnectionSecrets {
  readonly environment?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
}

export interface McpDiscoveredResource {
  readonly uri: string
  readonly name: string
  readonly description?: string
  readonly mimeType?: string
}

export interface McpConnectionSnapshot {
  readonly serverId: string
  readonly serverName: string
  readonly serverVersion?: { readonly name: string; readonly version: string }
  readonly capabilities: McpNegotiatedCapabilities
  readonly tools: readonly McpNamespacedTool[]
  readonly resources: readonly McpDiscoveredResource[]
  readonly connectedAt: string
  readonly processId?: number
}

export interface McpClientManagerOptions {
  readonly connectTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly closeTimeoutMs?: number
  readonly elicitationHandler?: McpClientElicitationHandler
  readonly now?: () => Date
}

export interface McpRequestOptions {
  readonly signal?: AbortSignal
  /**
   * The total deadline. It is enforced with an abort signal, so the server is
   * sent `notifications/cancelled` when it passes; progress cannot extend it.
   */
  readonly timeoutMs?: number
  /**
   * Receives the server's progress notifications. Passing it is what makes
   * the SDK send a `progressToken`, and each notification then restarts
   * `idleTimeoutMs`.
   */
  readonly onprogress?: (progress: Progress) => void
  /** The longest silence allowed between progress notifications. Defaults to `timeoutMs`. */
  readonly idleTimeoutMs?: number
}

export interface McpToolCallElicitationContext {
  readonly context: McpBrokerRequestContext
  readonly toolCallId: string
  readonly namespacedToolName: string
}

export interface McpToolCallRequestOptions extends McpRequestOptions {
  readonly elicitation?: McpToolCallElicitationContext
}

export interface McpClientElicitationHandlerInput {
  readonly serverId: string
  readonly context: McpBrokerRequestContext
  readonly toolCallId: string
  readonly namespacedToolName: string
  readonly request: ElicitRequest['params']
  readonly signal: AbortSignal
}

export type McpClientElicitationHandler = (
  input: McpClientElicitationHandlerInput,
) => Promise<ElicitResult>

type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport


interface LiveConnection {
  readonly client: Client
  readonly transport: McpClientTransport
  readonly lifetime: AbortController
  readonly snapshot: McpConnectionSnapshot
}

interface ActiveToolCall {
  readonly elicitation?: McpToolCallElicitationContext
  readonly signal: AbortSignal
}

interface CapturedStdioProcessTree {
  readonly rootProcessId: number
  readonly processIds: ReadonlySet<number>
}

export class McpClientManagerError extends Error {
  readonly code: McpSanitizedErrorCode
  readonly retryable: boolean

  constructor(code: McpSanitizedErrorCode, retryable = false) {
    super(mcpClientErrorMessage(code))
    this.name = 'McpClientManagerError'
    this.code = code
    this.retryable = retryable
  }
}

export class McpClientManager {
  private readonly connections = new Map<string, LiveConnection>()
  private readonly pendingConnections = new Map<string, AbortController>()
  private readonly pendingTransports = new Map<string, McpClientTransport>()
  private readonly serverLocks = new Map<string, Promise<void>>()
  private readonly toolLocks = new Map<string, Promise<void>>()
  private readonly activeToolCalls = new Map<string, ActiveToolCall>()
  private readonly connectTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly closeTimeoutMs: number
  private readonly now: () => Date
  private elicitationHandler: McpClientElicitationHandler | undefined

  constructor(options: McpClientManagerOptions = {}) {
    this.connectTimeoutMs = positiveTimeout(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
    )
    this.requestTimeoutMs = positiveTimeout(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    )
    this.closeTimeoutMs = positiveTimeout(
      options.closeTimeoutMs,
      DEFAULT_CLOSE_TIMEOUT_MS,
    )
    this.elicitationHandler = options.elicitationHandler
    this.now = options.now ?? (() => new Date())
  }

  setElicitationHandler(handler: McpClientElicitationHandler | undefined): void {
    if (
      this.connections.size > 0 ||
      this.pendingConnections.size > 0 ||
      this.pendingTransports.size > 0
    ) {
      throw new McpClientManagerError('configuration_invalid', false)
    }
    this.elicitationHandler = handler
  }

  async connect(
    server: McpServerSettings,
    secrets: McpConnectionSecrets = {},
  ): Promise<McpConnectionSnapshot> {
    const interruptedProcessTrees = this.abortServer(server.id)
    return this.withServerLock(server.id, async () => {
      await stopCapturedProcessTrees(
        interruptedProcessTrees,
        this.closeTimeoutMs,
      )
      return this.connectUnlocked(server, secrets)
    })
  }

  async close(serverId: string): Promise<void> {
    const interruptedProcessTrees = this.abortServer(serverId)
    await this.withServerLock(serverId, () => this.closeUnlocked(serverId))
    await stopCapturedProcessTrees(interruptedProcessTrees, this.closeTimeoutMs)
  }

  async closeAll(): Promise<void> {
    const serverIds = new Set([
      ...this.connections.keys(),
      ...this.pendingConnections.keys(),
      ...this.pendingTransports.keys(),
      ...this.serverLocks.keys(),
    ])
    const results = await Promise.allSettled(
      [...serverIds].map((serverId) => this.close(serverId)),
    )
    if (results.some((result) => result.status === 'rejected')) {
      throw new McpClientManagerError('internal', true)
    }
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId)
  }

  getSnapshot(serverId: string): McpConnectionSnapshot | null {
    return this.connections.get(serverId)?.snapshot ?? null
  }

  async callTool(
    serverId: string,
    params: { readonly name: string; readonly arguments?: McpJsonObject },
    options: McpToolCallRequestOptions = {},
  ): Promise<unknown> {
    return this.withToolLock(serverId, async () => {
      const connection = this.requireConnection(serverId)
      return this.runRequest(connection, options, async (signal, timeout) => {
        const active: ActiveToolCall = {
          ...(options.elicitation
            ? { elicitation: options.elicitation }
            : {}),
          signal,
        }
        this.activeToolCalls.set(serverId, active)
        try {
          return await connection.client.callTool(
            {
              name: params.name,
              ...whenDefined(params.arguments, (toolArguments) => ({
                arguments: toolArguments,
              })),
            },
            undefined,
            {
              signal,
              timeout: positiveTimeout(options.idleTimeoutMs, timeout),
              ...(options.onprogress
                ? { onprogress: options.onprogress, resetTimeoutOnProgress: true }
                : {}),
            },
          )
        } finally {
          if (this.activeToolCalls.get(serverId) === active) {
            this.activeToolCalls.delete(serverId)
          }
        }
      })
    })
  }

  async readResource(
    serverId: string,
    uri: string,
    options: McpRequestOptions = {},
  ): Promise<unknown> {
    const connection = this.requireConnection(serverId)
    return this.runRequest(connection, options, (signal, timeout) =>
      connection.client.readResource({ uri }, { signal, timeout }),
    )
  }

  private async connectUnlocked(
    server: McpServerSettings,
    secrets: McpConnectionSecrets,
  ): Promise<McpConnectionSnapshot> {
    await this.closeUnlocked(server.id)
    assertConnectableServer(server)

    const lifetime = new AbortController()
    this.pendingConnections.set(server.id, lifetime)
    let transport: McpClientTransport | null = null
    let client: Client | null = null

    try {
      const createdTransport = createTransport(server, secrets)
      transport = createdTransport
      this.pendingTransports.set(server.id, createdTransport)
      drainStdioErrorOutput(createdTransport)
      const createdClient = new Client(
        { name: 'pipeline-mcp-client', version: '1.0.0' },
        this.elicitationHandler
          ? { capabilities: { elicitation: { form: {}, url: {} } } }
          : undefined,
      )
      client = createdClient
      if (this.elicitationHandler) {
        createdClient.setRequestHandler(
          ElicitRequestSchema,
          (request, extra) => this.handleElicitation(
            server.id,
            request.params,
            extra.signal,
          ),
        )
      }
      await runWithTimeout(
        lifetime.signal,
        this.connectTimeoutMs,
        (signal) => createdClient.connect(new ExactOptionalMcpTransport(createdTransport), {
          signal,
          timeout: this.connectTimeoutMs,
        }),
      )
      observeTransportClose(createdTransport, () => {
        if (this.connections.get(server.id)?.transport === createdTransport) {
          this.connections.delete(server.id)
        }
      })
      const snapshot = await this.discover(
        server,
        createdClient,
        createdTransport,
        lifetime,
      )
      this.connections.set(server.id, {
        client: createdClient,
        transport: createdTransport,
        lifetime,
        snapshot,
      })
      return snapshot
    } catch (error) {
      if (client && transport) {
        await closeClient(client, transport, this.closeTimeoutMs)
      } else {
        await closeTransport(transport, this.closeTimeoutMs)
      }
      throw sanitizeManagerError(error, lifetime.signal, 'connection_failed')
    } finally {
      if (this.pendingConnections.get(server.id) === lifetime) {
        this.pendingConnections.delete(server.id)
      }
      if (transport && this.pendingTransports.get(server.id) === transport) {
        this.pendingTransports.delete(server.id)
      }
    }
  }

  private async discover(
    server: McpServerSettings,
    client: Client,
    transport: McpClientTransport,
    lifetime: AbortController,
  ): Promise<McpConnectionSnapshot> {
    try {
      const capabilities = negotiatedCapabilities(client)
      const tools = capabilities.tools
        ? await discoverTools(client, server, lifetime.signal, this.requestTimeoutMs)
        : []
      const resources = capabilities.resources
        ? await discoverResources(client, lifetime.signal, this.requestTimeoutMs)
        : []
      const version = client.getServerVersion()
      return {
        serverId: server.id,
        serverName: server.name,
        ...(version ? { serverVersion: { name: version.name, version: version.version } } : {}),
        capabilities,
        tools,
        resources,
        connectedAt: this.now().toISOString(),
        ...(transport instanceof StdioClientTransport && transport.pid
          ? { processId: transport.pid }
          : {}),
      }
    } catch (error) {
      throw sanitizeManagerError(error, lifetime.signal, 'protocol_error')
    }
  }

  private async runRequest<T>(
    connection: LiveConnection,
    options: McpRequestOptions,
    request: (signal: AbortSignal, timeout: number) => Promise<T>,
  ): Promise<T> {
    const timeout = positiveTimeout(options.timeoutMs, this.requestTimeoutMs)
    const callerSignal = options.signal
      ? AbortSignal.any([connection.lifetime.signal, options.signal])
      : connection.lifetime.signal
    try {
      return await runWithTimeout(callerSignal, timeout, (signal) =>
        request(signal, timeout),
      )
    } catch (error) {
      throw sanitizeManagerError(error, callerSignal, 'protocol_error')
    }
  }

  private requireConnection(serverId: string): LiveConnection {
    const connection = this.connections.get(serverId)
    if (!connection) throw new McpClientManagerError('connection_failed', true)
    return connection
  }

  private async handleElicitation(
    serverId: string,
    request: ElicitRequest['params'],
    requestSignal: AbortSignal,
  ): Promise<ElicitResult> {
    const handler = this.elicitationHandler
    const active = this.activeToolCalls.get(serverId)
    if (!handler || !active?.elicitation) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'MCP elicitation is unavailable outside an active authorized tool call.',
      )
    }
    return handler({
      serverId,
      context: active.elicitation.context,
      toolCallId: active.elicitation.toolCallId,
      namespacedToolName: active.elicitation.namespacedToolName,
      request,
      signal: AbortSignal.any([active.signal, requestSignal]),
    })
  }

  private abortServer(serverId: string): CapturedStdioProcessTree[] {
    const processTrees = new Map<number, CapturedStdioProcessTree>()
    for (const transport of [
      this.pendingTransports.get(serverId),
      this.connections.get(serverId)?.transport,
    ]) {
      if (transport instanceof StdioClientTransport && transport.pid) {
        processTrees.set(
          transport.pid,
          captureStdioProcessTree(transport.pid),
        )
      }
    }
    this.pendingConnections.get(serverId)?.abort()
    this.connections.get(serverId)?.lifetime.abort()
    return [...processTrees.values()]
  }

  private async closeUnlocked(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId)
    this.connections.delete(serverId)
    if (!connection) return
    connection.lifetime.abort()
    await closeClient(connection.client, connection.transport, this.closeTimeoutMs)
  }

  private async withServerLock<T>(
    serverId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.serverLocks.get(serverId) ?? Promise.resolve()
    const running = previous.catch(() => undefined).then(operation)
    const settled = running.then(() => undefined, () => undefined)
    this.serverLocks.set(serverId, settled)
    try {
      return await running
    } finally {
      if (this.serverLocks.get(serverId) === settled) {
        this.serverLocks.delete(serverId)
      }
    }
  }

  private async withToolLock<T>(
    serverId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.toolLocks.get(serverId) ?? Promise.resolve()
    const running = previous.catch(() => undefined).then(operation)
    const settled = running.then(() => undefined, () => undefined)
    this.toolLocks.set(serverId, settled)
    try {
      return await running
    } finally {
      if (this.toolLocks.get(serverId) === settled) {
        this.toolLocks.delete(serverId)
      }
    }
  }
}

async function discoverTools(
  client: Client,
  server: McpServerSettings,
  signal: AbortSignal,
  timeout: number,
): Promise<McpNamespacedTool[]> {
  const tools: McpNamespacedTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    const result = await runWithTimeout(signal, timeout, (requestSignal) =>
      client.listTools(cursor ? { cursor } : undefined, {
        signal: requestSignal,
        timeout,
      }),
    )
    for (const tool of result.tools) {
      const annotations = {
        ...whenDefined(tool.annotations?.readOnlyHint, (readOnlyHint) => ({ readOnlyHint })),
        ...whenDefined(tool.annotations?.destructiveHint, (destructiveHint) => ({ destructiveHint })),
        ...whenDefined(tool.annotations?.idempotentHint, (idempotentHint) => ({ idempotentHint })),
        ...whenDefined(tool.annotations?.openWorldHint, (openWorldHint) => ({ openWorldHint })),
      }
      const risk = classifyMcpToolRisk(annotations)
      tools.push({
        serverId: server.id,
        serverName: server.name,
        toolName: tool.name,
        namespacedName: namespaceMcpToolName(server.id, tool.name),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as McpJsonSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema as McpJsonSchema } : {}),
        annotations,
        risk,
        effect: resolveMcpCapabilityEffect(annotations),
        requiresApproval: mcpToolRequiresApproval(risk),
      })
    }
    cursor = result.nextCursor
    if (!cursor) return tools
  }
  throw new McpClientManagerError('protocol_error', false)
}

async function discoverResources(
  client: Client,
  signal: AbortSignal,
  timeout: number,
): Promise<McpDiscoveredResource[]> {
  const resources: McpDiscoveredResource[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    const result = await runWithTimeout(signal, timeout, (requestSignal) =>
      client.listResources(cursor ? { cursor } : undefined, {
        signal: requestSignal,
        timeout,
      }),
    )
    resources.push(...result.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      ...(resource.description ? { description: resource.description } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    })))
    cursor = result.nextCursor
    if (!cursor) return resources
  }
  throw new McpClientManagerError('protocol_error', false)
}

function negotiatedCapabilities(client: Client): McpNegotiatedCapabilities {
  const capabilities = client.getServerCapabilities()
  return {
    ...(capabilities?.tools
      ? { tools: { listChanged: Boolean(capabilities.tools.listChanged) } }
      : {}),
    ...(capabilities?.resources
      ? {
          resources: {
            listChanged: Boolean(capabilities.resources.listChanged),
            subscribe: Boolean(capabilities.resources.subscribe),
          },
        }
      : {}),
    ...(capabilities?.prompts
      ? { prompts: { listChanged: Boolean(capabilities.prompts.listChanged) } }
      : {}),
    logging: Boolean(capabilities?.logging),
  }
}

function createTransport(
  server: McpServerSettings,
  secrets: McpConnectionSecrets,
): McpClientTransport {
  if (server.transport.type === 'stdio') {
    return new StdioClientTransport({
      command: server.transport.command,
      args: [...server.transport.args],
      ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
      env: {
        ...getDefaultEnvironment(),
        ...(secrets.environment ?? {}),
      },
      stderr: 'pipe',
    })
  }
  if (server.transport.authentication.type === 'oauth') {
    throw new McpClientManagerError('unauthorized', false)
  }
  return new StreamableHTTPClientTransport(new URL(server.transport.url), {
    requestInit: {
      headers: { ...(secrets.headers ?? {}) },
      redirect: 'error',
    },
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
  })
}

function assertConnectableServer(server: McpServerSettings): void {
  if (!server.enabled) throw new McpClientManagerError('server_disabled', false)
  if (server.transport.type === 'stdio') {
    if (!server.transport.command || server.transport.command.includes('\0')) {
      throw new McpClientManagerError('configuration_invalid', false)
    }
    return
  }
  let url: URL
  try {
    url = new URL(server.transport.url)
  } catch {
    throw new McpClientManagerError('configuration_invalid', false)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new McpClientManagerError('configuration_invalid', false)
  }
  if (server.transport.authentication.type === 'oauth') {
    throw new McpClientManagerError('unauthorized', false)
  }
}

function drainStdioErrorOutput(transport: McpClientTransport): void {
  if (!(transport instanceof StdioClientTransport)) return
  transport.stderr?.on('data', () => undefined)
}

async function closeClient(
  client: Client,
  transport: McpClientTransport,
  timeoutMs: number,
): Promise<void> {
  const stdioProcessTree = transport instanceof StdioClientTransport && transport.pid
    ? captureStdioProcessTree(transport.pid)
    : null
  if (stdioProcessTree && process.platform === 'win32') {
    runWindowsTaskkill(
      stdioProcessTree.rootProcessId,
      true,
      Math.min(timeoutMs, 2_000),
    )
  }
  const closing = (async () => {
    if (transport instanceof StreamableHTTPClientTransport) {
      await transport.terminateSession().catch(() => undefined)
    }
    await client.close().catch(() => undefined)
  })()
  await settleWithin(closing, timeoutMs)
  if (stdioProcessTree) {
    await ensureStdioProcessTreeStopped(stdioProcessTree, timeoutMs)
  }
}

async function closeTransport(
  transport: McpClientTransport | null,
  timeoutMs: number,
): Promise<void> {
  if (!transport) return
  const stdioProcessTree = transport instanceof StdioClientTransport && transport.pid
    ? captureStdioProcessTree(transport.pid)
    : null
  if (stdioProcessTree && process.platform === 'win32') {
    runWindowsTaskkill(
      stdioProcessTree.rootProcessId,
      true,
      Math.min(timeoutMs, 2_000),
    )
  }
  await settleWithin(transport.close().catch(() => undefined), timeoutMs)
  if (stdioProcessTree) {
    await ensureStdioProcessTreeStopped(stdioProcessTree, timeoutMs)
  }
}

async function ensureStdioProcessTreeStopped(
  captured: CapturedStdioProcessTree,
  timeoutMs: number,
): Promise<void> {
  if (process.platform === 'win32') {
    await stopWindowsProcessTree(captured.rootProcessId, timeoutMs)
    return
  }
  const processIds = new Set(captured.processIds)
  mergeLiveDescendants(processIds)
  const liveBeforeTerminate = liveProcessIds(processIds)
  if (liveBeforeTerminate.length === 0) return
  signalProcessIds(
    orderProcessTreeBottomUp(processIds, captured.rootProcessId),
    'SIGTERM',
  )
  const terminationGraceMs = Math.min(Math.max(timeoutMs, 250), 1_000)
  if (await waitForProcessesStop(processIds, terminationGraceMs)) return
  mergeLiveDescendants(processIds)
  signalProcessIds(
    orderProcessTreeBottomUp(processIds, captured.rootProcessId),
    'SIGKILL',
  )
  if (!await waitForProcessesStop(processIds, 1_000)) {
    throw new McpClientManagerError('internal', true)
  }
}

async function stopCapturedProcessTrees(
  processTrees: readonly CapturedStdioProcessTree[],
  timeoutMs: number,
): Promise<void> {
  for (const processTree of processTrees) {
    await ensureStdioProcessTreeStopped(processTree, timeoutMs)
  }
}

async function waitForProcessesStop(
  processIds: ReadonlySet<number>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (liveProcessIds(processIds).length > 0) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(20, remaining))
    })
  }
  return true
}

function captureStdioProcessTree(rootProcessId: number): CapturedStdioProcessTree {
  const processIds = new Set<number>()
  if (!isSafeChildProcessId(rootProcessId)) {
    return { rootProcessId, processIds }
  }
  processIds.add(rootProcessId)
  if (process.platform !== 'win32') mergeLiveDescendants(processIds)
  return { rootProcessId, processIds }
}

function mergeLiveDescendants(processIds: Set<number>): void {
  if (process.platform === 'win32' || processIds.size === 0) return
  const parentByProcess = readProcessParents()
  if (!parentByProcess) return
  const childrenByParent = new Map<number, number[]>()
  for (const [processId, parentProcessId] of parentByProcess) {
    const children = childrenByParent.get(parentProcessId) ?? []
    children.push(processId)
    childrenByParent.set(parentProcessId, children)
  }
  const queue = [...processIds]
  // for...of also visits the children pushed onto the queue inside the loop.
  for (const parentProcessId of queue) {
    for (const childProcessId of childrenByParent.get(parentProcessId) ?? []) {
      if (processIds.has(childProcessId)) continue
      if (processIds.size >= MAX_CAPTURED_PROCESS_COUNT) return
      processIds.add(childProcessId)
      queue.push(childProcessId)
    }
  }
}

function orderProcessTreeBottomUp(
  processIds: ReadonlySet<number>,
  rootProcessId: number,
): number[] {
  const parentByProcess = readProcessParents() ?? new Map<number, number>()
  return liveProcessIds(processIds).sort((left, right) => {
    if (left === right) return 0
    if (left === rootProcessId) return 1
    if (right === rootProcessId) return -1
    return processDepth(right, rootProcessId, parentByProcess) -
      processDepth(left, rootProcessId, parentByProcess)
  })
}

function processDepth(
  processId: number,
  rootProcessId: number,
  parentByProcess: ReadonlyMap<number, number>,
): number {
  let depth = 0
  let current = processId
  const visited = new Set<number>()
  while (current !== rootProcessId && !visited.has(current)) {
    visited.add(current)
    const parent = parentByProcess.get(current)
    if (!parent) break
    current = parent
    depth += 1
    if (depth >= MAX_CAPTURED_PROCESS_COUNT) break
  }
  return current === rootProcessId ? depth : 0
}

function readProcessParents(): Map<number, number> | null {
  let output: string
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: PROCESS_TREE_QUERY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const parents = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    const processId = Number(match[1])
    const parentProcessId = Number(match[2])
    if (!isSafeChildProcessId(processId)) continue
    parents.set(processId, parentProcessId)
  }
  return parents
}

function liveProcessIds(processIds: ReadonlySet<number>): number[] {
  return [...processIds]
    .filter((processId) =>
      isSafeChildProcessId(processId) && isProcessRunning(processId),
    )
    .sort((left, right) => right - left)
}

function signalProcessIds(
  processIds: readonly number[],
  signal: NodeJS.Signals,
): void {
  for (const processId of processIds) signalProcess(processId, signal)
}

async function stopWindowsProcessTree(
  rootProcessId: number,
  timeoutMs: number,
): Promise<void> {
  if (!isSafeChildProcessId(rootProcessId) || !isProcessRunning(rootProcessId)) {
    return
  }
  runWindowsTaskkill(rootProcessId, false, timeoutMs)
  const terminationGraceMs = Math.min(Math.max(timeoutMs, 250), 1_000)
  if (await waitForProcessesStop(new Set([rootProcessId]), terminationGraceMs)) {
    return
  }
  runWindowsTaskkill(rootProcessId, true, Math.min(timeoutMs, 2_000))
  if (!await waitForProcessesStop(new Set([rootProcessId]), 1_000)) {
    throw new McpClientManagerError('internal', true)
  }
}

function runWindowsTaskkill(
  rootProcessId: number,
  force: boolean,
  timeoutMs: number,
): void {
  const args = ['/PID', String(rootProcessId), '/T']
  if (force) args.push('/F')
  spawnSync('taskkill.exe', args, {
    stdio: 'ignore',
    windowsHide: true,
    timeout: Math.max(250, timeoutMs),
  })
}

function isSafeChildProcessId(processId: number): boolean {
  return Number.isSafeInteger(processId) &&
    processId > 1 &&
    processId !== process.pid &&
    processId !== process.ppid
}

function signalProcess(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(processId, signal)
  } catch {
    // The child may have exited between the liveness check and the signal.
  }
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function observeTransportClose(
  transport: McpClientTransport,
  onClose: () => void,
): void {
  const previousOnClose = transport.onclose
  transport.onclose = () => {
    previousOnClose?.()
    onClose()
  }
}

async function runWithTimeout<T>(
  lifetimeSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = AbortSignal.any([lifetimeSignal, timeoutController.signal])
  try {
    return await operation(signal)
  } catch (error) {
    if (timeoutController.signal.aborted && !lifetimeSignal.aborted) {
      throw new McpClientManagerError('timeout', true)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
}

function sanitizeManagerError(
  error: unknown,
  lifetimeSignal: AbortSignal,
  fallbackCode: McpSanitizedErrorCode,
): McpClientManagerError {
  if (error instanceof McpClientManagerError) return error
  if (lifetimeSignal.aborted) return new McpClientManagerError('cancelled', false)
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new McpClientManagerError('timeout', true)
  }
  const errorRecord = error && typeof error === 'object'
    ? error as { code?: unknown; status?: unknown }
    : null
  if (errorRecord?.code === 401 || errorRecord?.status === 401) {
    return new McpClientManagerError('unauthorized', false)
  }
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('unauthorized') || /(?:http|status)\s*401/.test(message)) {
    return new McpClientManagerError('unauthorized', false)
  }
  return new McpClientManagerError(fallbackCode, true)
}

function mcpClientErrorMessage(code: McpSanitizedErrorCode): string {
  switch (code) {
    case 'configuration_invalid':
      return 'MCP server configuration is invalid.'
    case 'server_disabled':
      return 'MCP server is disabled.'
    case 'unauthorized':
      return 'MCP authorization is required.'
    case 'timeout':
      return 'MCP server connection timed out.'
    case 'cancelled':
      return 'MCP server operation was cancelled.'
    case 'protocol_error':
      return 'MCP server protocol negotiation failed.'
    default:
      return 'MCP server connection failed.'
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}
