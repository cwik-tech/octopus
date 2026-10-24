/**
 * Octopus's connection to the voice layer, through the same MCP client
 * manager the app uses for every other server.
 *
 * The voice layer is found in the discovery folder: its descriptor names the
 * URL, and the grant it wrote for Octopus names the credential. Without both,
 * nothing connects.
 */
import {
  McpClientManager,
  type McpRequestOptions,
} from '../../domains/mcp/mcp-client-manager.js'
import { normalizeMcpJsonValue } from '../../domains/mcp/mcp-broker-policy.js'
import type { McpJsonObject, McpJsonValue } from '../../domains/mcp/mcp-runtime.js'
import type { McpServerSettings } from '../../domains/mcp/mcp-settings.js'
import {
  readVoiceLayerEndpoint,
  type VoiceLayerEndpoint,
} from '../../domains/voice-control/discovery-files.js'
import type {
  VoiceNotifyInput,
  VoiceSetStatusInput,
  VoiceSayInput,
  VoiceSayProgress,
  VoiceSayResult,
} from '../../contracts/voice-control.js'
import { voiceSayProgressSchema, voiceSayResultSchema } from '../../contracts/voice-control.js'
import * as z from 'zod/v4'

const VOICE_SERVER_ID = 'voice-layer'
/** `notify` and `set_status` record and return; they never wait on a person. */
const VOICE_CALL_TIMEOUT_MS = 10_000
const SPEECH_TOTAL_TIMEOUT_MS = 120_000
const SPEECH_IDLE_TIMEOUT_MS = 30_000
const speechReceiptSchema = z.object({ isError: z.boolean().optional(), structuredContent: voiceSayResultSchema })

export type VoiceCallOutcome = 'delivered' | 'refused' | 'unreachable'

export interface VoiceLayerLink {
  /**
   * Connects to the voice layer the discovery folder names, or drops the
   * connection when it is gone. Returns true when this call made a new
   * connection, so the caller can resend what a new listener needs to know.
   */
  refresh(): Promise<boolean>
  readonly connected: boolean
  notify(input: VoiceNotifyInput): Promise<VoiceCallOutcome>
  setStatus(input: VoiceSetStatusInput): Promise<VoiceCallOutcome>
  say(input: VoiceSayInput, options: { readonly signal: AbortSignal; readonly onProgress: (progress: VoiceSayProgress) => void }): Promise<
    { readonly kind: 'delivered'; readonly result: VoiceSayResult } | { readonly kind: 'unreachable' | 'refused' }>
  close(): Promise<void>
}

export function createVoiceLayerLink(input: {
  readonly discoveryDir: string
  readonly appId: string
}): VoiceLayerLink {
  const manager = new McpClientManager({ requestTimeoutMs: VOICE_CALL_TIMEOUT_MS })
  let current: VoiceLayerEndpoint | undefined

  const drop = async (): Promise<void> => {
    current = undefined
    await manager.close(VOICE_SERVER_ID).catch(() => undefined)
  }

  const call = async (name: string, args: Record<string, unknown>): Promise<VoiceCallOutcome> => {
    if (current === undefined || !manager.isConnected(VOICE_SERVER_ID)) return 'unreachable'
    const options: McpRequestOptions = { timeoutMs: VOICE_CALL_TIMEOUT_MS }
    const normalized = normalizeMcpJsonValue(args)
    if (!isJsonObject(normalized)) return 'refused'
    let result: unknown
    try {
      result = await manager.callTool(VOICE_SERVER_ID, { name, arguments: normalized }, options)
    } catch {
      // The call may or may not have reached the voice layer. Reconnect next
      // time and let the outbox send it again; `dedupeKey` absorbs a repeat.
      await drop()
      return 'unreachable'
    }
    return isToolError(result) ? 'refused' : 'delivered'
  }

  return {
    get connected() {
      return current !== undefined && manager.isConnected(VOICE_SERVER_ID)
    },
    async refresh() {
      const endpoint = await readVoiceLayerEndpoint(input.discoveryDir, input.appId)
      if (endpoint === null) {
        if (current !== undefined) await drop()
        return false
      }
      if (current !== undefined && sameEndpoint(current, endpoint) && manager.isConnected(VOICE_SERVER_ID)) {
        return false
      }
      await drop()
      try {
        await manager.connect(voiceServerSettings(endpoint.url), { headers: { ...endpoint.headers } })
      } catch {
        return false
      }
      current = endpoint
      return true
    },
    notify: (notification) => call('notify', { ...notification }),
    setStatus: (status) => call('set_status', { ...status }),
    say: async (speech, options) => {
      if (current === undefined || !manager.isConnected(VOICE_SERVER_ID)) return { kind: 'unreachable' }
      const args = normalizeMcpJsonValue({ ...speech })
      if (!isJsonObject(args)) return { kind: 'refused' }
      let invalidProgress = false
      let result: unknown
      try {
        result = await manager.callTool(VOICE_SERVER_ID, { name: 'say', arguments: args }, {
          signal: options.signal,
          timeoutMs: SPEECH_TOTAL_TIMEOUT_MS,
          idleTimeoutMs: SPEECH_IDLE_TIMEOUT_MS,
          onprogress: (progress) => {
            if (options.signal.aborted) return
            const parsed = parseSpeechProgress(progress.message)
            if (parsed !== undefined && speech.utteranceId !== undefined && parsed.utteranceId !== speech.utteranceId) return
            if (parsed === undefined || parsed.totalChars !== speech.text.length) {
              invalidProgress = true
              return
            }
            options.onProgress(parsed)
          },
        })
      } catch {
        if (options.signal.aborted) return { kind: 'unreachable' }
        await drop()
        return { kind: 'unreachable' }
      }
      if (options.signal.aborted) return { kind: 'unreachable' }
      const receipt = speechReceiptSchema.safeParse(result)
      if (invalidProgress || !receipt.success || receipt.data.isError === true ||
          (speech.utteranceId !== undefined && receipt.data.structuredContent.utteranceId !== speech.utteranceId) ||
          receipt.data.structuredContent.heardChars > speech.text.length) return { kind: 'refused' }
      return { kind: 'delivered', result: receipt.data.structuredContent }
    },
    close: async () => {
      current = undefined
      await manager.closeAll().catch(() => undefined)
    },
  }
}

function voiceServerSettings(url: string): McpServerSettings {
  return {
    id: VOICE_SERVER_ID,
    name: 'Voice layer',
    enabled: true,
    capabilityAliases: [],
    transport: {
      type: 'streamable-http',
      url,
      // The credential is passed per connection from the grant file and never stored here.
      encryptedHeaders: {},
      authentication: { type: 'secret-headers' },
    },
    status: 'unvalidated',
    capabilities: { logging: false },
  }
}

function sameEndpoint(left: VoiceLayerEndpoint, right: VoiceLayerEndpoint): boolean {
  return left.url === right.url && left.pid === right.pid &&
    JSON.stringify(left.headers) === JSON.stringify(right.headers)
}

function isJsonObject(value: McpJsonValue): value is McpJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'isError' in result && result.isError === true
}

function parseSpeechProgress(message: string | undefined): VoiceSayProgress | undefined {
  if (message === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(message) } catch { return undefined }
  const parsed = voiceSayProgressSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
