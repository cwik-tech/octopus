import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ArtifactMarkdownImage } from '@/components/artifact-markdown-image'

// jsdom has no browser object-URL registry. Replace only that browser API;
// image bytes still come from a real loopback HTTP server.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('displays a local blob image under the desktop content policy and releases it on close', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDc0AAAAASUVORK5CYII=', 'base64')
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(png) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Image server missing')
  const create = vi.fn<(blob: Blob) => string>(() => 'blob:verified-artifact-image')
  const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  try {
    const view = render(<ArtifactMarkdownImage url={`http://127.0.0.1:${address.port}/frame.png`} alt="Training slide" />)
    await waitFor(() => expect(screen.getByAltText('Training slide')).toHaveAttribute('src', 'blob:verified-artifact-image'))
    expect(create.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ type: 'image/png', size: png.length }))
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:verified-artifact-image')
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})
