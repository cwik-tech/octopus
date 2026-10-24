import * as path from 'node:path'

import { VOICE_CONTROL_CONTRACT } from '../../contracts/voice-control.js'
import type { RunStore } from '../../domains/run/run-store.js'
import type { SessionStore } from '../../domains/sessions/session-store.js'
import {
  removeAppDescriptor,
  writeAppDescriptor,
} from '../../domains/voice-control/discovery-files.js'
import { APP_MCP_PATH, createAppMcpEndpoint, type AppMcpEndpoint } from './app-mcp-endpoint.js'
import { createLoopbackRestClient } from './loopback-rest-client.js'
import { createOctopusMcpTools } from './octopus-mcp-tools.js'
import {
  createVoiceAttentionService,
  type VoiceAttentionService,
} from './voice-attention-service.js'
import { createVoiceLayerLink } from './voice-layer-link.js'

export const OCTOPUS_APP_ID = 'octopus'
export const OCTOPUS_APP_NAME = 'Octopus'

export interface VoiceControlOptions {
  /** Bearer token for `/_pipeline-mcp`. Must differ from every other token. */
  readonly mcpToken: string
  /**
   * The discovery folder. When set, the server writes its descriptor there on
   * listen and removes it on shutdown. Without it the endpoint still answers,
   * but nothing advertises it.
   */
  readonly discoveryDir?: string
  /** How often task changes are checked for the voice layer. Defaults to one second. */
  readonly attentionIntervalMs?: number
  /**
   * Brings the window forward with a session open. The desktop supplies it;
   * a server without a window leaves it out, and `show` says so.
   */
  readonly show?: (target: VoiceControlShowTarget) => Promise<void>
  /** Signals saved external chat work; it must not activate the desktop. */
  readonly sessionChanged?: (sessionId: string) => void
}

export interface VoiceControlShowTarget {
  readonly sessionId: string
  readonly taskId?: string
}

const DEFAULT_ATTENTION_INTERVAL_MS = 1_000

export interface VoiceControlRuntime {
  readonly endpoint: AppMcpEndpoint
  activate(context: { readonly baseUrl: string; readonly publicUrl: string }): Promise<void>
  dispose(): Promise<void>
}

export function createVoiceControlRuntime(
  options: VoiceControlOptions,
  dependencies: {
    readonly sessionStore?: SessionStore
    readonly runStore?: RunStore
    readonly workspacePath?: string
    readonly findDialogueSession?: (dialogueId: string, signal: AbortSignal) => Promise<string | undefined>
  } = {},
): VoiceControlRuntime {
  let restBaseUrl: string | undefined
  let descriptorWritten = false
  const rest = createLoopbackRestClient(() => restBaseUrl)
  // Telling the voice layer about tasks needs a place to find it and tasks to
  // watch. Without either, the endpoint still serves tools.
  const attention: VoiceAttentionService | undefined =
    options.discoveryDir !== undefined &&
    dependencies.sessionStore !== undefined &&
    dependencies.workspacePath !== undefined
      ? createVoiceAttentionService({
          sessionStore: dependencies.sessionStore,
          ...(dependencies.runStore === undefined ? {} : { runStore: dependencies.runStore }),
          rest,
          link: createVoiceLayerLink({ discoveryDir: options.discoveryDir, appId: OCTOPUS_APP_ID }),
          outboxFile: path.join(dependencies.workspacePath, 'voice-control', 'outbox.json'),
          intervalMs: options.attentionIntervalMs ?? DEFAULT_ATTENTION_INTERVAL_MS,
        })
      : undefined
  const endpoint = createAppMcpEndpoint({
    token: options.mcpToken,
    serverName: OCTOPUS_APP_NAME,
    serverVersion: '1.0.0',
    tools: createOctopusMcpTools(rest, {
      ...(options.show === undefined ? {} : { show: options.show }),
      ...(options.sessionChanged === undefined ? {} : { sessionChanged: options.sessionChanged }),
      ...(dependencies.findDialogueSession === undefined ? {} : { findDialogueSession: dependencies.findDialogueSession }),
    }),
  })
  return {
    endpoint,
    async activate({ baseUrl, publicUrl }) {
      restBaseUrl = publicUrl
      if (options.discoveryDir === undefined) return
      await writeAppDescriptor(options.discoveryDir, {
        contract: VOICE_CONTROL_CONTRACT,
        appId: OCTOPUS_APP_ID,
        name: OCTOPUS_APP_NAME,
        role: 'app',
        pid: process.pid,
        mcp: {
          type: 'http',
          url: `${baseUrl}${APP_MCP_PATH}`,
          headers: { Authorization: `Bearer ${options.mcpToken}` },
        },
        updatedAt: new Date().toISOString(),
      })
      descriptorWritten = true
      await attention?.start()
    },
    async dispose() {
      await attention?.stop()
      // The descriptor goes first, so nobody is pointed at a closing server.
      if (descriptorWritten && options.discoveryDir !== undefined) {
        await removeAppDescriptor(options.discoveryDir, OCTOPUS_APP_ID, process.pid)
        descriptorWritten = false
      }
      await endpoint.close()
    },
  }
}
