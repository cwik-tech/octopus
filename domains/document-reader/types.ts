import type { DocumentAnalysisStatus } from '../../contracts/sessions.js'

export const DOCUMENT_EVIDENCE_SCHEMA_VERSION = 1;

export type { DocumentAnalysisStatus };

export interface DocumentReaderSelection {
  provider: string;
  model: string;
}

export interface DocumentEvidencePage {
  page: number;
  title?: string;
  content: string;
  keyFacts: string[];
  tableMarkdown?: string;
  unreadable?: boolean;
}

export interface DocumentEvidence {
  summary: string;
  pages: DocumentEvidencePage[];
  warnings: string[];
}

export interface DocumentAnalysisRecord {
  status: DocumentAnalysisStatus;
  sourceHash?: string;
  provider?: string;
  model?: string;
  evidenceOutput?: string;
  metadataOutput?: string;
  generatedAt?: string;
  promptVersion?: number;
  error?: string;
}

export interface DocumentReaderRequest {
  expectedPageCount?: number;
  selection: DocumentReaderSelection;
  filename: string;
  contents: Buffer;
  signal?: AbortSignal;
}

export type DocumentReaderResult =
  | {
      ok: true;
      evidence: DocumentEvidence;
      provider: string;
      model: string;
    }
  | { ok: false; reason: string };
