import type * as http from 'node:http'
import type { URL } from 'node:url'

import { browserModeRequestSchema } from '../../contracts/schemas/settings-requests.js'
import type { BrowserFaviconService } from '../../services/browser-favicon-service.js'
import type { BrowserSettingsService } from '../../services/browser-settings-service.js'
import type { BrowserToolService } from '../../services/browser-tool-service.js'
import { ApiRequestError, createRequestAbort, readJsonBody, writeJson } from '../http.js'

/** A hit is stable for a day; a miss is retried far sooner. */
const FAVICON_HIT_CACHE_CONTROL = 'private, max-age=86400'
const FAVICON_MISS_CACHE_CONTROL = 'private, max-age=3600'

export async function handleBrowserRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly settings?: Pick<BrowserSettingsService, 'snapshot' | 'setMode' | 'openProfile' | 'stop'>
  readonly tools?: Pick<BrowserToolService, 'listSession' | 'readAttachment'>
  readonly favicons?: Pick<BrowserFaviconService, 'read'>
}): Promise<boolean> {
  const { req, res, url } = params
  if (url.pathname === '/settings/browser') {
    res.setHeader('cache-control', 'no-store')
    if (!params.settings) {
      writeJson(res, 503, { error: 'Browser settings are unavailable' })
      return true
    }
    if (req.method === 'GET') {
      writeJson(res, 200, await params.settings.snapshot())
      return true
    }
    if (req.method === 'PUT') {
      let payload: unknown
      try {
        payload = await readJsonBody(req, 8 * 1_024)
      } catch (error) {
        writeJson(res, error instanceof ApiRequestError ? error.statusCode : 400, { error: 'Browser settings request is invalid' })
        return true
      }
      if (payload === null) {
        // Preserve the legacy null-body transport response without pretending
        // that null has a settings-object shape.
        res.statusCode = 500
        res.end()
        return true
      }
      const body = browserModeRequestSchema.safeParse(payload)
      if (!body.success) {
        writeJson(res, 400, { error: 'Browser mode is invalid' })
        return true
      }
      writeJson(res, 200, await params.settings.setMode(body.data.mode))
      return true
    }
    res.setHeader('allow', 'GET, PUT')
    writeJson(res, 405, { error: 'Method not allowed' })
    return true
  }
  if (url.pathname === '/settings/browser/open-profile' || url.pathname === '/settings/browser/stop') {
    res.setHeader('cache-control', 'no-store')
    if (!params.settings) {
      writeJson(res, 503, { error: 'Browser settings are unavailable' })
      return true
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      writeJson(res, 405, { error: 'Method not allowed' })
      return true
    }
    const snapshot = url.pathname.endsWith('/open-profile')
      ? await params.settings.openProfile()
      : await params.settings.stop()
    writeJson(res, 200, snapshot)
    return true
  }
  const activityMatch = url.pathname.match(/^\/sessions\/([^/]+)\/browser-activity$/)
  if (activityMatch) {
    res.setHeader('cache-control', 'no-store')
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      writeJson(res, 405, { error: 'Method not allowed' })
      return true
    }
    if (!params.tools) {
      writeJson(res, 200, { activities: [] })
      return true
    }
    const encodedSessionId = activityMatch[1]
    if (encodedSessionId === undefined) {
      writeJson(res, 400, { error: 'Session ID is invalid' })
      return true
    }
    let sessionId: string
    try {
      sessionId = decodeURIComponent(encodedSessionId)
    } catch {
      writeJson(res, 400, { error: 'Session ID is invalid' })
      return true
    }
    writeJson(res, 200, { activities: await params.tools.listSession(sessionId) })
    return true
  }
  const faviconMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/browser-activity\/favicon$/,
  )
  if (faviconMatch) {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      writeJson(res, 405, { error: 'Method not allowed' })
      return true
    }
    // A miss and a refusal look identical from outside, so the route never
    // reveals which origins a session visited.
    const missing = (): true => {
      res.statusCode = 404
      res.setHeader('cache-control', FAVICON_MISS_CACHE_CONTROL)
      res.end()
      return true
    }
    const encodedSessionId = faviconMatch[1]
    if (encodedSessionId === undefined) return missing()
    let sessionId: string
    try {
      sessionId = decodeURIComponent(encodedSessionId)
    } catch {
      writeJson(res, 400, { error: 'Session ID is invalid' })
      return true
    }
    const origin = url.searchParams.get('origin')
    if (!origin || !params.favicons) return missing()
    const abort = createRequestAbort(req, res)
    try {
      const icon = await params.favicons.read(sessionId, origin, abort.signal)
      if (!icon) return missing()
      res.statusCode = 200
      res.setHeader('content-type', icon.mimeType)
      res.setHeader('content-length', String(icon.data.byteLength))
      res.setHeader('cache-control', FAVICON_HIT_CACHE_CONTROL)
      res.end(Buffer.from(icon.data))
      return true
    } catch {
      // The icon is optional decoration; a transport failure is reported as an
      // absent icon rather than surfaced to the renderer as an error.
      return missing()
    } finally {
      abort.dispose()
    }
  }
  const attachmentMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/browser-activity\/([^/]+)\/attachment$/,
  )
  if (attachmentMatch) {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      writeJson(res, 405, { error: 'Method not allowed' })
      return true
    }
    const [, encodedSessionId, encodedActivityId] = attachmentMatch
    if (encodedSessionId === undefined || encodedActivityId === undefined) {
      writeJson(res, 400, { error: 'Attachment path is invalid' })
      return true
    }
    let sessionId: string
    let activityId: string
    try {
      sessionId = decodeURIComponent(encodedSessionId)
      activityId = decodeURIComponent(encodedActivityId)
    } catch {
      writeJson(res, 400, { error: 'Attachment path is invalid' })
      return true
    }
    const attachment = await params.tools?.readAttachment(sessionId, activityId)
    if (!attachment) {
      writeJson(res, 404, { error: 'Browser attachment was not found' })
      return true
    }
    res.statusCode = 200
    res.setHeader('content-type', attachment.mimeType)
    res.setHeader('content-disposition', `inline; filename="${safeHeaderName(attachment.name)}"`)
    res.setHeader('cache-control', 'no-store')
    res.end(attachment.data)
    return true
  }
  return false
}

function safeHeaderName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'attachment'
}
