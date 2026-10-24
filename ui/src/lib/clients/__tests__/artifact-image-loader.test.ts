import { createServer, type RequestListener } from 'node:http'
import { expect, it } from 'vitest'
import { loadArtifactImage } from '../artifact-image-loader'

async function imageServer(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Image server missing')
  return { url: `http://127.0.0.1:${address.port}/image`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }) }
}

it.each([
  { bytes: [255, 216, 255, 224], type: 'image/jpeg' },
  { bytes: [...new TextEncoder().encode('GIF89a')], type: 'image/gif' },
  { bytes: [...new TextEncoder().encode('RIFF1234WEBP')], type: 'image/webp' },
])('recognizes $type bytes served as a generic binary', async ({ bytes, type }) => {
  const server = await imageServer((_request, response) => response.end(Buffer.from(bytes)))
  try { expect((await loadArtifactImage(server.url, new AbortController().signal)).type).toBe(type) }
  finally { await server.close() }
})

it('rejects non-image bytes rather than rendering them as a local image', async () => {
  const server = await imageServer((_request, response) => response.end('<html>not an image</html>'))
  try { await expect(loadArtifactImage(server.url, new AbortController().signal)).rejects.toThrow('not a supported image') }
  finally { await server.close() }
})

it('rejects an image response larger than ten MiB', async () => {
  const server = await imageServer((_request, response) => response.end(Buffer.alloc(10_485_761)))
  try { await expect(loadArtifactImage(server.url, new AbortController().signal)).rejects.toThrow('size limit') }
  finally { await server.close() }
})

it('cancels an in-flight image request when its document closes', async () => {
  let started: (() => void) | undefined
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  const server = await imageServer((_request, response) => { response.writeHead(200); response.flushHeaders(); started?.() })
  const controller = new AbortController()
  const pending = loadArtifactImage(server.url, controller.signal)
  try { await requestStarted; controller.abort(); await expect(pending).rejects.toThrow() }
  finally { await server.close() }
})

it('loads a document image group with at most four simultaneous requests', async () => {
  let active = 0
  let maximum = 0
  let released = false
  const waiting: Array<() => void> = []
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const server = await imageServer((_request, response) => {
    active += 1; maximum = Math.max(maximum, active)
    const finish = () => { active -= 1; response.end(png) }
    if (released) finish()
    else {
      waiting.push(finish)
      if (waiting.length === 4) { released = true; waiting.forEach((release) => release()) }
    }
  })
  try {
    await Promise.all(Array.from({ length: 8 }, () => loadArtifactImage(server.url, new AbortController().signal)))
    expect(maximum).toBe(4)
  } finally { await server.close() }
})
