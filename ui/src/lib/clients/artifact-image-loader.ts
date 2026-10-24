const maximumImageBytes = 10 * 1024 * 1024
const maximumConcurrentImages = 4
let activeImages = 0
const waiting: Array<() => void> = []

async function acquire(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (activeImages < maximumConcurrentImages) { activeImages += 1; return }
  await new Promise<void>((resolve, reject) => {
    const enter = () => {
      signal.removeEventListener('abort', cancel)
      activeImages += 1
      resolve()
    }
    const cancel = () => {
      const index = waiting.indexOf(enter)
      if (index >= 0) waiting.splice(index, 1)
      reject(new DOMException('Image loading cancelled.', 'AbortError'))
    }
    waiting.push(enter)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

/** Uses the allowed API connection, then gives the renderer a CSP-safe blob. */
export async function loadArtifactImage(url: string, signal: AbortSignal): Promise<Blob> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  await acquire(bounded)
  try {
    const response = await fetch(url, { signal: bounded })
    if (!response.ok || !response.body) throw new Error('Screenshot is unavailable.')
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > maximumImageBytes) throw new Error('Screenshot exceeds the image size limit.')
        chunks.push(new Uint8Array(value))
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const type = imageType(bytes)
    if (!type) throw new Error('Screenshot is not a supported image.')
    return new Blob([bytes], { type })
  } finally {
    activeImages -= 1
    waiting.shift()?.()
  }
}

// The artifact endpoint also serves binaries as application/octet-stream.
// Validate the bytes instead of trusting an extension or that generic MIME type.
function imageType(bytes: Uint8Array): string | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  const prefix = new TextDecoder().decode(bytes.subarray(0, 12))
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif'
  if (prefix.startsWith('RIFF') && prefix.slice(8) === 'WEBP') return 'image/webp'
  return undefined
}
