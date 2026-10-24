import type * as http from 'node:http'
import type { URL } from 'node:url'

import {
  youtubeGeminiCandidateValidationRequestSchema,
  youtubeSettingsUpdateRequestSchema,
} from '../../contracts/schemas/settings-requests.js'
import type { YoutubeSettingsService } from '../../services/youtube-settings-service.js'
import type { YoutubeSettingsUpdate } from '../../domains/youtube/youtube-settings.js'
import { ApiRequestError, readJsonBody, writeJson } from '../http.js'

const MAX_REQUEST_BYTES = 16 * 1_024

export async function handleYoutubeSettingsRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly service?: Pick<
    YoutubeSettingsService,
    'snapshot' | 'update' | 'validate' | 'validateGemini' |
    'validateGeminiCandidate' | 'listGeminiModels'
  >
}): Promise<boolean> {
  const { req, res, url, service } = params
  if (url.pathname === '/settings/youtube') {
    res.setHeader('cache-control', 'no-store')
    if (!service) {
      writeJson(res, 503, { error: 'YouTube settings are unavailable.' })
      return true
    }
    if (req.method === 'GET') {
      writeJson(res, 200, await service.snapshot())
      return true
    }
    if (req.method === 'PATCH') {
      try {
        writeJson(res, 200, await service.update(parseUpdate(
          await readJsonBody(req, MAX_REQUEST_BYTES),
        )))
      } catch (error) {
        writeJson(res, error instanceof ApiRequestError ? error.statusCode : 400, {
          error: error instanceof Error ? error.message : 'YouTube settings request is invalid.',
        })
      }
      return true
    }
    res.setHeader('allow', 'GET, PATCH')
    writeJson(res, 405, { error: 'Method not allowed' })
    return true
  }
  if (url.pathname === '/settings/youtube/validate') {
    res.setHeader('cache-control', 'no-store')
    if (!service) {
      writeJson(res, 503, { error: 'YouTube settings are unavailable.' })
      return true
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      writeJson(res, 405, { error: 'Method not allowed' })
      return true
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      const snapshot = await service.validate(controller.signal)
      if (!res.destroyed) writeJson(res, 200, snapshot)
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
    }
    return true
  }
  if (url.pathname === '/settings/youtube/gemini/validate') {
    res.setHeader('cache-control', 'no-store')
    if (!service) {
      writeJson(res, 503, { error: 'YouTube settings are unavailable.' })
      return true
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      writeJson(res, 405, { error: 'Method not allowed' })
      return true
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      const body = await readJsonBody(req, MAX_REQUEST_BYTES)
      const hasCandidate = body && typeof body === 'object' && Object.keys(body).length > 0
      if (hasCandidate) {
        const parsed = youtubeGeminiCandidateValidationRequestSchema.safeParse(body)
        if (!parsed.success) {
          throw new ApiRequestError(
            parsed.error.issues[0]?.message ?? 'Gemini validation request is invalid.',
            400,
          )
        }
        const validated = await service.validateGeminiCandidate(parsed.data, controller.signal)
        if (!res.destroyed) writeJson(res, 200, validated)
      } else {
        const snapshot = await service.validateGemini(controller.signal)
        if (!res.destroyed) writeJson(res, 200, snapshot)
      }
    } catch (error) {
      if (!res.destroyed) writeJson(res, error instanceof ApiRequestError ? error.statusCode : 400, {
        error: error instanceof Error ? error.message : 'Gemini validation request is invalid.',
      })
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
    }
    return true
  }
  if (url.pathname === '/settings/youtube/gemini/models') {
    res.setHeader('cache-control', 'no-store')
    if (!service) {
      writeJson(res, 503, { error: 'YouTube settings are unavailable.' })
      return true
    }
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      writeJson(res, 405, { error: 'Method not allowed' })
      return true
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      const models = await service.listGeminiModels(controller.signal)
      if (!res.destroyed) writeJson(res, 200, { models })
    } catch {
      if (!res.destroyed) {
        writeJson(res, 503, {
          error: 'Gemini models could not be loaded. Check the API key and try again.',
        })
      }
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
    }
    return true
  }
  return false
}

function parseUpdate(value: unknown): YoutubeSettingsUpdate {
  const result = youtubeSettingsUpdateRequestSchema.safeParse(value)
  if (!result.success) {
    throw new Error(
      result.error.issues[0]?.message
        ?? 'YouTube settings request is invalid.',
    )
  }
  return result.data
}
