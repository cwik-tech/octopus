import type { ModelImage } from '../contracts/model-image.js'

/** Shared by Anthropic Messages and Claude Code's structured stdin protocol. */
export function anthropicImageBlocks(text: string, images: readonly ModelImage[]) {
  return [
    { type: 'text', text },
    ...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })),
  ]
}
