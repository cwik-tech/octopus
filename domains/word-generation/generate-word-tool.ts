import { whenDefined } from '../../core/optional-properties.js'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'

import {
  callParentGenerateWordTool,
  GenerateWordToolClientError,
} from './generate-word-tool-client.js'
import type { GenerateWordToolInput } from './generate-word-types.js'

export interface GenerateWordToolConfig {
  readonly signal?: AbortSignal
  readonly getAgentPath: () => string | undefined
}

export function createGenerateWordTool(config: GenerateWordToolConfig) {
  return defineTool({
    name: 'generate_word',
    label: 'Generate Word',
    description: [
      'Generate a formatted Word (.docx) document from a Markdown artifact in the current assignment.',
      'The Markdown may be supplied directly or read from an assignment-relative file.',
      'Supports Word-native headings, tables, lists, table of contents, embedded local images,',
      'and local Mermaid-to-PNG rendering with reusable formatting profiles.',
    ].join(' '),
    promptSnippet: [
      'Use list_profiles when the document type is unclear.',
      'Use generate after the Markdown source artifact is complete.',
    ].join(' '),
    promptGuidelines: [
      'Input and output paths must be relative to the current assignment.',
      'Do not use Generate Word to rewrite content; it is a deterministic format transform.',
      'Report generation warnings rather than claiming missing images were embedded.',
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list_profiles'),
        Type.Literal('generate'),
      ]),
      inputPath: Type.Optional(Type.String({ maxLength: 512 })),
      markdown: Type.Optional(Type.String({ maxLength: 10 * 1_024 * 1_024 })),
      outputPath: Type.Optional(Type.String({ maxLength: 512 })),
      profile: Type.Optional(Type.String({ maxLength: 128 })),
      tableOfContents: Type.Optional(Type.Boolean()),
      renderMermaid: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const agentPath = config.getAgentPath()
      if (!agentPath) {
        return textResult('generate_word: no active agent owns this tool call.')
      }
      try {
        const response = await callParentGenerateWordTool({
          agentPath,
          toolCallId,
          input: params as GenerateWordToolInput,
          ...whenDefined(signal ?? config.signal, (definedValue) => ({ signal: definedValue })),
        })
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(response.output, null, 2),
          }],
          details: response.output,
        }
      } catch (error) {
        const message = error instanceof GenerateWordToolClientError
          ? error.message
          : 'Word generation failed.'
        return textResult(`generate_word: ${message}`)
      }
    },
  })
}

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: null,
  }
}
