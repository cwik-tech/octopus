import * as z from 'zod/v4'

export interface YoutubeFrameScheduleCandidate {
  readonly stepId: string
  readonly timestampSeconds: number
  readonly requestedTimestampSeconds: number
  readonly selectionReason: 'required_bracket' | 'dense_interval'
  readonly requiredCueId?: string
}

/**
 * A frame chosen for a manual, as captured and as read back from `frames.json`.
 *
 * The file is written by this app, but it is read from disk on resume, so it
 * is checked like any other outside input. The type is derived from this
 * schema, so the check and the type cannot drift apart.
 */
const youtubeSelectedFrameSchema = z.object({
  stepId: z.string(),
  importance: z.enum(['required', 'supporting']).exactOptional(),
  requestedTimestampSeconds: z.number(),
  actualTimestampSeconds: z.number(),
  relativePath: z.string(),
  caption: z.string(),
  altText: z.string(),
  selectionReason: z.string(),
  sha256: z.string(),
  visualHash: z.string().exactOptional(),
  meanLuma: z.number().exactOptional(),
  lumaRange: z.number().exactOptional(),
  blurScore: z.number().exactOptional(),
}).readonly()

export type YoutubeSelectedFrame = z.infer<typeof youtubeSelectedFrameSchema>

export function isYoutubeSelectedFrame(value: unknown): value is YoutubeSelectedFrame {
  return youtubeSelectedFrameSchema.safeParse(value).success
}
