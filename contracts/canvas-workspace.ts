import { z } from 'zod'

export const CANVAS_MAX_TABS = 32
export const CANVAS_MAX_RUN_ID_CHARS = 200
export const CANVAS_MAX_PATH_CHARS = 1024
export const CANVAS_MAX_KEY_CHARS = 2600
export const CANVAS_MAX_REQUEST_BYTES = 8 * 1024
export const CANVAS_MAX_STORE_BYTES = 64 * 1024
export const CANVAS_MAX_PREVIEW_BYTES = 2 * 1024 * 1024
export const CANVAS_REQUEST_TIMEOUT_MS = 20_000
export const CANVAS_STORE_FILENAME = 'canvas.json'
export const CANVAS_DEFAULT_CHAT_SIZE = 55
export const CANVAS_DEFAULT_PANE_SIZE = 45
export const CANVAS_CHANGE_CHANNEL_PREFIX = 'pipeline-canvas:'

export const canvasTabSchema = z.strictObject({
  runId: z.string().min(1).max(CANVAS_MAX_RUN_ID_CHARS).regex(/^[A-Za-z0-9_-]+$/),
  artifactPath: z.string().min(1).max(CANVAS_MAX_PATH_CHARS).refine((value) =>
    !/[\\\x00-\x1f]/.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && !/^[A-Za-z]:/.test(value),
  ),
})
export type CanvasTab = z.infer<typeof canvasTabSchema>
export function canvasTabKey(target: CanvasTab): string {
  return JSON.stringify([target.runId, target.artifactPath])
}
export const canvasWorkspaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tabs: z.array(canvasTabSchema).max(CANVAS_MAX_TABS),
  activeKey: z.string().max(CANVAS_MAX_KEY_CHARS).nullable(),
}).refine((value) => {
  const keys = value.tabs.map(canvasTabKey)
  return new Set(keys).size === keys.length && (keys.length === 0 ? value.activeKey === null : value.activeKey !== null && keys.includes(value.activeKey))
})
export type CanvasWorkspace = z.infer<typeof canvasWorkspaceSchema>
export const canvasActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open'), target: canvasTabSchema }),
  z.strictObject({ kind: z.literal('select'), key: z.string().min(1).max(CANVAS_MAX_KEY_CHARS) }),
  z.strictObject({ kind: z.literal('close'), key: z.string().min(1).max(CANVAS_MAX_KEY_CHARS) }),
])
export type CanvasAction = z.infer<typeof canvasActionSchema>
export const canvasContentSchema = z.strictObject({ content: z.string().max(CANVAS_MAX_PREVIEW_BYTES) })
export const canvasWindowStateSchema = z.strictObject({ sessionId: z.string(), detached: z.boolean(), epoch: z.number().int().nonnegative() })
export type CanvasWindowState = z.infer<typeof canvasWindowStateSchema>
