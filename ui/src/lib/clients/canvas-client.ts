import { canvasContentSchema, canvasWorkspaceSchema, CANVAS_REQUEST_TIMEOUT_MS, type CanvasAction, type CanvasTab, type CanvasWorkspace } from '@contracts/canvas-workspace'
import { getApiBaseUrl } from '@/lib/utils/desktop'

export function canvasWorkspaceUrl(sessionId: string): string {
  return `${getApiBaseUrl()}/sessions/${encodeURIComponent(sessionId)}/canvas`
}
async function request(url: string, signal: AbortSignal, action?: CanvasAction): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(CANVAS_REQUEST_TIMEOUT_MS)]),
    ...(action ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) } : {}),
  })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Canvas request failed'
    throw new Error(message)
  }
  return payload
}
export async function fetchCanvasWorkspace(sessionId: string, signal: AbortSignal, action?: CanvasAction): Promise<CanvasWorkspace> {
  return canvasWorkspaceSchema.parse(await request(canvasWorkspaceUrl(sessionId), signal, action))
}
export async function fetchCanvasContent(sessionId: string, target: CanvasTab, signal: AbortSignal): Promise<string> {
  const query = new URLSearchParams(target)
  return canvasContentSchema.parse(await request(`${canvasWorkspaceUrl(sessionId)}/content?${query}`, signal)).content
}
