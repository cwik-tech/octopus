/// <reference types="node" />
import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'

it('deleting a conversation removes only its drafts after the server accepts deletion', async () => {
  const statuses = [503, 204]
  const server = createServer((_request, response) => { response.writeHead(statuses.shift() ?? 500); response.end() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  sessionStorage.setItem('pipeline.desktop-api-base-url', `http://127.0.0.1:${address.port}/_pipeline/${'a'.repeat(43)}`)
  const { deleteSession } = await import('../session-client')
  localStorage.setItem('agent-question:session-one:task:question', 'Marta')
  localStorage.setItem('agent-question:session-two:task:question', 'Ada')
  try {
    await expect(deleteSession('session-one')).rejects.toThrow()
    expect(localStorage.getItem('agent-question:session-one:task:question')).toBe('Marta')
    await deleteSession('session-one')
    expect(localStorage.getItem('agent-question:session-one:task:question')).toBeNull()
    expect(localStorage.getItem('agent-question:session-two:task:question')).toBe('Ada')
  } finally {
    localStorage.clear(); sessionStorage.clear(); server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
