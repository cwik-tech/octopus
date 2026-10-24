import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

import {
  ExactOptionalMcpTransport,
  type McpSdkTransport,
} from '../../domains/mcp/mcp-transport-adapter.js'

class InMemoryMcpTransport implements McpSdkTransport {
  onclose?: (() => void) | undefined
  onerror?: ((error: Error) => void) | undefined
  onmessage?: (<T extends JSONRPCMessage>(message: T) => void) | undefined
  sessionId?: string | undefined
  readonly sent: JSONRPCMessage[] = []

  async start(): Promise<void> {
    this.sessionId = 'session-1'
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message)
  }

  async close(): Promise<void> {
    delete this.sessionId
    this.onclose?.()
  }
}

describe('ExactOptionalMcpTransport', () => {
  it('forwards lifecycle operations and synchronizes the SDK session ID', async () => {
    const inner = new InMemoryMcpTransport()
    const transport = new ExactOptionalMcpTransport(inner)
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/test',
    }
    let closed = false
    transport.onclose = () => {
      closed = true
    }

    await transport.start()
    await transport.send(message)
    await transport.close()

    assert.deepEqual(inner.sent, [message])
    assert.equal(closed, true)
    assert.equal(transport.sessionId, undefined)
  })
})
