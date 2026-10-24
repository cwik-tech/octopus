import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js'
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js'

export interface McpSdkTransport {
  start(): Promise<void>
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>
  close(): Promise<void>
  onclose?: (() => void) | undefined
  onerror?: ((error: Error) => void) | undefined
  onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined
  sessionId?: string | undefined
  setProtocolVersion?: ((version: string) => void) | undefined
}

/** Bridges MCP SDK declarations emitted without exact-optional compatibility. */
export class ExactOptionalMcpTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void
  sessionId?: string
  setProtocolVersion?: (version: string) => void

  constructor(private readonly transport: McpSdkTransport) {
    transport.onclose = () => this.onclose?.()
    transport.onerror = (error) => this.onerror?.(error)
    transport.onmessage = (message, extra) => {
      this.syncSessionId()
      this.onmessage?.(message, extra)
    }
    if (transport.setProtocolVersion) {
      this.setProtocolVersion = (version) => transport.setProtocolVersion?.(version)
    }
    this.syncSessionId()
  }

  async start(): Promise<void> {
    await this.transport.start()
    this.syncSessionId()
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.transport.send(message, options)
  }

  async close(): Promise<void> {
    await this.transport.close()
    this.syncSessionId()
  }

  private syncSessionId(): void {
    delete this.sessionId
    if (this.transport.sessionId !== undefined) this.sessionId = this.transport.sessionId
  }
}
