import type { LmEnrichmentScope, ParseQuality } from '../types.js'

export interface EnrichmentPageInput {
  page: number
  title: string
  parseQuality: ParseQuality
  qualityScore: number
  text: string
  imagePath?: string
}

export interface EnrichmentRequest {
  source: string
  classification: 'scanned' | 'visual' | 'text-heavy'
  parseQuality: ParseQuality
  qualityScore: number
  lmScope: LmEnrichmentScope
  flaggedPages: number[]
  documentKind: 'report' | 'slide-deck' | 'mixed'
  pages: EnrichmentPageInput[]
}

export interface EnrichmentPageOutput {
  page: number
  title: string
  summary: string
  visual_elements: string[]
  table_like: boolean
  extracted_table_markdown?: string
  extracted_key_values?: Array<{
    label: string
    value: string
  }>
  extracted_claims?: string[]
}

export interface EnrichmentMetric {
  label: string
  value: string
  page?: number
}

export interface EnrichmentResponse {
  document_summary: string
  document_kind: 'report' | 'slide-deck' | 'mixed'
  key_entities: string[]
  key_metrics: EnrichmentMetric[]
  page_summaries: EnrichmentPageOutput[]
  recommended_pages: number[]
  confidence: 'low' | 'medium' | 'high'
}

export interface EnrichmentResult {
  provider: string
  model: string
  response: EnrichmentResponse
  rawText: string
}

export interface LmEnricher {
  provider: string
  enrichPdf(request: EnrichmentRequest): Promise<EnrichmentResult>
}
