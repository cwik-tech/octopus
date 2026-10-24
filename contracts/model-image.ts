import * as z from 'zod/v4'

/** Runtime-only visual input; never a path that a provider can resolve later. */
export const modelImageSchema = z.strictObject({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  data: z.base64().min(4).max(2_800_000),
})
export type ModelImage = z.infer<typeof modelImageSchema>

export const modelImagesSchema = z.array(modelImageSchema).max(16).refine(
  (images) => images.reduce((bytes, image) => bytes + Buffer.byteLength(image.data, 'base64'), 0) <= 8 * 1024 * 1024,
  'Image inputs exceed the 8 MiB turn limit',
)
