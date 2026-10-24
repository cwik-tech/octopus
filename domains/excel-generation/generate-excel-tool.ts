import { whenDefined } from '../../core/optional-properties.js'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'

import {
  callParentGenerateExcelTool,
  GenerateExcelToolClientError,
} from './generate-excel-tool-client.js'
import type { GenerateExcelToolInput } from './generate-excel-types.js'

export interface GenerateExcelToolConfig {
  readonly signal?: AbortSignal
  readonly getAgentPath: () => string | undefined
}

export function createGenerateExcelTool(config: GenerateExcelToolConfig) {
  return defineTool({
    name: 'generate_excel',
    label: 'Generate Excel',
    description: [
      'Generate an Excel (.xlsx) workbook in the current assignment.',
      'generate converts a Markdown artifact: every table becomes a styled worksheet with typed',
      'cells (numbers, percentages, currency, dates, =formulas) using reusable formatting profiles.',
      'fill_template writes a JSON data artifact into a curated workbook template, preserving the',
      'template formulas, formatting, and charts exactly.',
    ].join(' '),
    promptSnippet: [
      'Use list_profiles or list_templates when the target format is unclear.',
      'Use generate after the Markdown source artifact is complete,',
      'or fill_template after the JSON data artifact matches the template inputs.',
    ].join(' '),
    promptGuidelines: [
      'Input and output paths must be relative to the current assignment.',
      'Do not use Generate Excel to rewrite content; it is a deterministic format transform.',
      'For fill_template, first call list_templates and produce JSON data matching the declared cells and tables exactly.',
      'Never compute derived figures the template already computes with formulas; supply raw inputs only.',
      'Report generation warnings rather than claiming dropped rows or skipped sections were exported.',
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list_profiles'),
        Type.Literal('list_templates'),
        Type.Literal('generate'),
        Type.Literal('fill_template'),
      ]),
      inputPath: Type.Optional(Type.String({ maxLength: 512 })),
      outputPath: Type.Optional(Type.String({ maxLength: 512 })),
      profile: Type.Optional(Type.String({ maxLength: 128 })),
      template: Type.Optional(Type.String({ maxLength: 128 })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const agentPath = config.getAgentPath()
      if (!agentPath) {
        return textResult('generate_excel: no active agent owns this tool call.')
      }
      try {
        const response = await callParentGenerateExcelTool({
          agentPath,
          toolCallId,
          input: params as GenerateExcelToolInput,
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
        const message = error instanceof GenerateExcelToolClientError
          ? error.message
          : 'Excel generation failed.'
        return textResult(`generate_excel: ${message}`)
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
