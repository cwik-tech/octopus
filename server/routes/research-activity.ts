import type * as http from 'node:http'
import type { URL } from 'node:url'

import type { BrowserFaviconService } from '../../services/browser-favicon-service.js'
import type { ResearchActivityProjectionService } from '../../services/research-activity-projection-service.js'
import { createRequestAbort, writeJson } from '../http.js'

/** A hit is stable for a day; a miss is retried far sooner. */
const FAVICON_HIT_CACHE_CONTROL = 'private, max-age=86400'
const FAVICON_MISS_CACHE_CONTROL = 'private, max-age=3600'

/**
 * The renderer's one source of research activity for a session.
 *
 * Answers for both research tools through the projection, so the UI polls a
 * single endpoint and never has to know which tool recorded a step. The legacy
 * browser-activity routes remain for compatibility and still own browser
 * attachments.
 */
export async function handleResearchActivityRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly activities?: Pick<
    ResearchActivityProjectionService,
    'listSession' | 'listVisitedUrls'
  >
  readonly favicons?: Pick<BrowserFaviconService, 'read'>
}): Promise<boolean> {
  const { req, res, url } = params
  const activityMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/research-activity$/,
  )
  if (activityMatch) {
    res.setHeader('cache-control', 'no-store')
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      writeJson(res, 405, { error: 'Method not allowed' })
      return true
    }
    const sessionId = decodedSegment(activityMatch[1])
    if (sessionId === null) {
      writeJson(res, 400, { error: 'Session ID is invalid' })
      return true
    }
    if (!params.activities) {
      writeJson(res, 200, { activities: [] })
      return true
    }
    writeJson(res, 200, {
      activities: await params.activities.listSession(sessionId),
    })
    return true
  }
  const faviconMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/research-activity\/favicon$/,
  )
  if (!faviconMatch) return false
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
  const sessionId = decodedSegment(faviconMatch[1])
  if (sessionId === null) {
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

/**
 * One captured path segment, decoded.
 *
 * `null` for an absent capture as well as an undecodable one, so a caller has a
 * single invalid answer to act on rather than a group it has to assume is there.
 */
function decodedSegment(value: string | undefined): string | null {
  if (value === undefined) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
