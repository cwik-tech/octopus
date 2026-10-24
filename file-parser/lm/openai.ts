import * as fs from 'node:fs'
import { getLlmRuntimeConfigFromEnv } from './llm-model.js'
import type {
  EnrichmentRequest,
  EnrichmentResponse,
  EnrichmentResult,
  LmEnricher,
} from './types.js'

interface OpenAiLmConfig {
  apiKey: string
  model: string
  baseUrl: string
}

function buildPrompt(request: EnrichmentRequest): string {
  return [
    'You are enriching parsed PDF content for downstream automation.',
    'Return valid JSON only. No markdown fences.',
    'Use the provided page text and optional page images.',
    'Focus on recovering structure, visual meaning, tables, and numeric evidence that deterministic parsing may miss.',
    'Do not settle for saying that a table exists. If a page contains a table, comparison matrix, scorecard, financial schedule, competitive landscape, or acquisition table, transcribe the useful rows and columns into markdown as faithfully as possible.',
    'If exact transcription is partially uncertain, still extract the best recoverable structure and preserve the numeric values and labels that are visible.',
    'Prefer evidence extraction over vague summarization.',
    '',
    'JSON contract:',
    '{',
    '  "document_summary": string,',
    '  "document_kind": "report" | "slide-deck" | "mixed",',
    '  "key_entities": string[],',
    '  "key_metrics": [{"label": string, "value": string, "page"?: number}],',
    '  "page_summaries": [{"page": number, "title": string, "summary": string, "visual_elements": string[], "table_like": boolean, "extracted_table_markdown"?: string, "extracted_key_values"?: [{"label": string, "value": string}], "extracted_claims"?: string[]}],',
    '  "recommended_pages": number[],',
    '  "confidence": "low" | "medium" | "high"',
    '}',
    '',
    `Source file: ${request.source}`,
    `Classification: ${request.classification}`,
    `Parse quality: ${request.parseQuality} (${request.qualityScore})`,
    `Document kind hint: ${request.documentKind}`,
    `LM scope: ${request.lmScope}`,
    request.flaggedPages.length > 0
      ? `Flagged pages: ${request.flaggedPages.join(', ')}`
      : 'Flagged pages: none',
    '',
    'Extraction rules:',
    '- When page.table_like is likely true, try to return `extracted_table_markdown` with column headers and rows.',
    '- Extract concrete numbers, percentages, dollar amounts, dates, company names, and comparison values into `extracted_key_values` and `key_metrics`.',
    '- Use `extracted_claims` for concise evidence statements that could matter to downstream analysis.',
    '- Keep summaries compact; spend output budget on recoverable evidence.',
  ].join('\n')
}

function extractOutputText(payload: unknown): string {
  const response = recordOrNull(payload)
  if (typeof response?.["output_text"] === 'string' && response["output_text"].trim()) {
    return response["output_text"].trim()
  }

  const outputs = Array.isArray(response?.["output"]) ? response["output"] : []
  const texts: string[] = []

  for (const item of outputs) {
    const itemRecord = recordOrNull(item)
    const contents = Array.isArray(itemRecord?.["content"]) ? itemRecord["content"] : []
    for (const content of contents) {
      const contentRecord = recordOrNull(content)
      if (typeof contentRecord?.["text"] === 'string') texts.push(contentRecord["text"])
    }
  }

  return texts.join('\n').trim()
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseJsonPayload(text: string): EnrichmentResponse {
  const normalized = text.trim()
  const json = normalized.startsWith('```')
    ? normalized.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : normalized

  return JSON.parse(json) as EnrichmentResponse
}

function imagePathToDataUrl(imagePath: string): string | null {
  if (!fs.existsSync(imagePath)) return null
  const raw = fs.readFileSync(imagePath)
  const ext = imagePath.split('.').pop()?.toLowerCase()
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${raw.toString('base64')}`
}

export class OpenAiLmEnricher implements LmEnricher {
  readonly provider = 'openai'
  private readonly config: OpenAiLmConfig

  constructor(config: OpenAiLmConfig) {
    this.config = config
  }

  async enrichPdf(request: EnrichmentRequest): Promise<EnrichmentResult> {
    const userContent: Array<Record<string, unknown>> = [
      {
        type: 'input_text',
        text: JSON.stringify({
          source: request.source,
          classification: request.classification,
          parse_quality: request.parseQuality,
          quality_score: request.qualityScore,
          lm_scope: request.lmScope,
          document_kind: request.documentKind,
          flagged_pages: request.flaggedPages,
          pages: request.pages.map((page) => ({
            page: page.page,
            title: page.title,
            parse_quality: page.parseQuality,
            quality_score: page.qualityScore,
            text: page.text,
            has_image: Boolean(page.imagePath),
          })),
        }, null, 2),
      },
    ]

    for (const page of request.pages) {
      if (!page.imagePath) continue
      const dataUrl = imagePathToDataUrl(page.imagePath)
      if (!dataUrl) continue
      userContent.push({
        type: 'input_text',
        text: `Page ${page.page} image for visual recovery.`,
      })
      userContent.push({
        type: 'input_image',
        image_url: dataUrl,
      })
    }

    const response = await fetch(`${this.config.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: buildPrompt(request),
              },
            ],
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`OpenAI enrichment failed (${response.status}): ${errorBody}`)
    }

    const payload = await response.json()
    const rawText = extractOutputText(payload)
    if (!rawText) {
      throw new Error('OpenAI enrichment returned no text output.')
    }

    const parsed = parseJsonPayload(rawText)
    return {
      provider: this.provider,
      model: this.config.model,
      response: parsed,
      rawText,
    }
  }
}

export function createOpenAiLmEnricherFromEnv(): OpenAiLmEnricher | null {
  const config = getLlmRuntimeConfigFromEnv()
  const apiKey = config.openAiApiKey
  if (!apiKey) return null

  return new OpenAiLmEnricher({
    apiKey,
    model: config.model,
    baseUrl: config.openAiBaseUrl,
  })
}
