import { whenDefined } from '../../core/optional-properties.js'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'

import { callParentYoutubeTool, YoutubeToolClientError } from './youtube-tool-client.js'
import type { YoutubeToolInput } from './youtube-types.js'

export interface YoutubeToolConfig {
  readonly signal?: AbortSignal
  readonly getAgentPath: () => string | undefined
}

export function createYoutubeTool(config: YoutubeToolConfig) {
  return defineTool({
    name: 'youtube_extract',
    label: 'YouTube Extractor',
    description: [
      'Capture resumable transcripts from YouTube videos, playlists, or channels.',
      'Read transcript chunks, persist methodology artifacts, and generate screenshot-rich Markdown and Word manuals.',
    ].join(' '),
    promptSnippet: [
      'Use inspect before large sources when scope is unclear. Capture defaults to the latest 10 items.',
      'If capture reports authenticatedFallbackRequired, call capture_authenticated only when account access is necessary.',
      'If capture reports premierePending, never call capture_authenticated; rerun after the scheduled availability.',
      'For manuals, capture the transcript before prepare_manual, then finish with build_manual. prepare_manual requires documentRequest: formats (markdown and/or docx, only as requested, default markdown), purpose (takeaways or instructions), and instructions (the original user request). Copy it unchanged into transcript plans.',
    ].join(' '),
    promptGuidelines: [
      'Never request or expose browser cookies, Webshare credentials, or request headers.',
      'Do not run methodology extraction unless the user explicitly requests it.',
      'Use read_transcript for chunked analysis and the write actions for final methodology artifacts.',
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('inspect'), Type.Literal('capture'), Type.Literal('resume'),
        Type.Literal('capture_authenticated'), Type.Literal('read_transcript'),
        Type.Literal('write_methodology'), Type.Literal('write_consolidation'),
        Type.Literal('prepare_manual'), Type.Literal('write_manual_plan'),
        Type.Literal('build_manual'),
      ]),
      url: Type.Optional(Type.String()),
      languages: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      all: Type.Optional(Type.Boolean()),
      includeShorts: Type.Optional(Type.Boolean()),
      minDurationSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400 })),
      videoId: Type.Optional(Type.String()),
      chunkIndex: Type.Optional(Type.Integer({ minimum: 0 })),
      content: Type.Optional(Type.String({ maxLength: 250_000 })),
      fileName: Type.Optional(Type.String({ maxLength: 180 })),
      templateId: Type.Optional(Type.Union([
        Type.Literal('quick-guide'), Type.Literal('step-by-step'),
        Type.Literal('dense-visual'),
      ])),
      documentRequest: Type.Optional(Type.Object({ formats: Type.Array(Type.Union([Type.Literal('markdown'), Type.Literal('docx')]), { minItems: 1, maxItems: 2, uniqueItems: true }), purpose: Type.Union([Type.Literal('instructions'), Type.Literal('takeaways')]), instructions: Type.String({ minLength: 1, maxLength: 8000 }) }, { additionalProperties: false })),
      outputLanguage: Type.Optional(Type.String({ maxLength: 64 })),
      freshAnalysis: Type.Optional(Type.Boolean()),
      geminiConfirmed: Type.Optional(Type.Boolean()),
      manualRunId: Type.Optional(Type.String({ maxLength: 128 })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const agentPath = config.getAgentPath()
      if (!agentPath) return textResult('youtube_extract: no active agent owns this tool call.')
      try {
        const response = await callParentYoutubeTool({
          agentPath,
          toolCallId,
          input: params as YoutubeToolInput,
          ...whenDefined(signal ?? config.signal, (definedValue) => ({ signal: definedValue })),
        })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response.output, null, 2) }],
          details: response.output,
        }
      } catch (error) {
        const message = error instanceof YoutubeToolClientError
          ? error.message
          : 'YouTube extractor action failed.'
        return textResult(`youtube_extract: ${message}`)
      }
    },
  })
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: null }
}
