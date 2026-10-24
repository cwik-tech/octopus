import { whenDefined } from "../../core/optional-properties.js"
import {
  documentReaderSelectionError,
  readPdfWithDocumentReader,
} from "./document-reader.js";
import type {
  DocumentAnalysisRecord,
  DocumentEvidence,
  DocumentReaderSelection,
} from "./types.js";
import {
  TeamFileStore,
  type TeamDocumentReaderInput,
} from "../team-files/team-file-store.js";

const DOCUMENT_READER_PROMPT_VERSION = 2;
const inFlightAnalyses = new Map<string, Promise<string | null>>();

export async function ensureTeamDocumentEvidence(params: {
  store: TeamFileStore;
  ownerId: string;
  selection?: DocumentReaderSelection;
  signal?: AbortSignal;
}): Promise<string[]> {
  const files = await params.store.listFiles(params.ownerId);
  const warnings: string[] = [];
  for (const file of files) {
    // Without a selection, a file that needs no reader is skipped. With one it is still
    // checked: local OCR removes the requirement for a remote reader, it does not veto a
    // reader the user explicitly selected.
    if (file.documentAnalysis?.status === "not_needed" && !params.selection) continue;
    const warning = await ensureFileEvidence({
      ...params,
      filename: file.name,
    });
    if (warning) warnings.push(warning);
  }
  return warnings;
}

async function ensureFileEvidence(params: {
  store: TeamFileStore;
  ownerId: string;
  filename: string;
  selection?: DocumentReaderSelection;
  signal?: AbortSignal;
}): Promise<string | null> {
  const input = await params.store.readDocumentReaderInput(
    params.ownerId,
    params.filename,
  );
  if (!input) return null;
  const selection = params.selection;
  // A document that does not require a reader is left alone — unless the user explicitly
  // selected one for it. Readers remain available for semantic interpretation of PDFs, so an
  // explicit selection runs even when local OCR (or clean extraction) made it unnecessary.
  if (!input.requiresDocumentReader && !(selection && input.type === "pdf")) return null;
  if (!selection) {
    return `${input.name} needs a document reader because its PDF text extraction is incomplete.`;
  }
  const selectionError = documentReaderSelectionError(selection);
  if (selectionError) return `${input.name} was not read: ${selectionError}.`;
  if (await evidenceIsCurrent({
    store: params.store,
    ownerId: params.ownerId,
    analysis: input.documentAnalysis,
    sourceHash: input.sourceHash,
    selection,
  })) {
    return null;
  }

  const key = [
    params.ownerId,
    input.name,
    input.sourceHash,
    selection.provider,
    selection.model,
  ].join("\u0000");
  const active = inFlightAnalyses.get(key);
  if (active) return active;

  const task = createEvidence({ ...params, selection, input }).finally(() => {
    inFlightAnalyses.delete(key);
  });
  inFlightAnalyses.set(key, task);
  return task;
}

async function createEvidence(params: {
  store: TeamFileStore;
  ownerId: string;
  filename: string;
  selection: DocumentReaderSelection;
  signal?: AbortSignal;
  input: TeamDocumentReaderInput;
}): Promise<string | null> {
  const result = await readPdfWithDocumentReader({
    selection: params.selection,
    filename: params.input.name,
    contents: params.input.contents,
    ...whenDefined(params.input.expectedPageCount, (expectedPageCount) => ({ expectedPageCount })),
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  });
  if (!result.ok) {
    await params.store.saveDocumentAnalysisFailure({
      ownerId: params.ownerId,
      filename: params.input.name,
      sourceHash: params.input.sourceHash,
      record: {
        status: "failed",
        provider: params.selection.provider,
        model: params.selection.model,
        generatedAt: new Date().toISOString(),
        promptVersion: DOCUMENT_READER_PROMPT_VERSION,
        error: result.reason,
      },
    });
    return `${params.input.name} could not be read: ${result.reason}.`;
  }

  await params.store.saveDocumentEvidence({
    ownerId: params.ownerId,
    filename: params.input.name,
    sourceHash: params.input.sourceHash,
    record: {
      status: "ready",
      provider: result.provider,
      model: result.model,
      generatedAt: new Date().toISOString(),
      promptVersion: DOCUMENT_READER_PROMPT_VERSION,
    },
    evidence: result.evidence,
    markdown: renderDocumentEvidence(params.input.name, result.evidence),
  });
  return null;
}

async function evidenceIsCurrent(params: {
  store: TeamFileStore;
  ownerId: string;
  analysis: DocumentAnalysisRecord | undefined;
  sourceHash: string;
  selection: DocumentReaderSelection;
}): Promise<boolean> {
  const { analysis } = params;
  if (
    analysis?.status !== "ready" ||
    analysis.sourceHash !== params.sourceHash ||
    analysis.provider !== params.selection.provider.trim().toLowerCase() ||
    analysis.model !== params.selection.model.trim() ||
    analysis.promptVersion !== DOCUMENT_READER_PROMPT_VERSION ||
    !analysis.evidenceOutput
  ) {
    return false;
  }
  return (await params.store.readParsedText(params.ownerId, analysis.evidenceOutput)) !== null;
}

export function renderDocumentEvidence(
  filename: string,
  evidence: DocumentEvidence,
): string {
  const lines = [
    `# Document evidence: ${filename}`,
    "",
    "## Summary",
    "",
    evidence.summary || "No summary was recovered.",
  ];
  for (const page of evidence.pages) {
    lines.push("", `## Page ${page.page}${page.title ? ` — ${page.title}` : ""}`, "", page.content);
    if (page.keyFacts.length > 0) {
      lines.push("", "### Key facts", "", ...page.keyFacts.map((fact) => `- ${fact}`));
    }
    if (page.tableMarkdown) lines.push("", "### Extracted table", "", page.tableMarkdown);
    if (page.unreadable) lines.push("", "_This page was partly unreadable._");
  }
  if (evidence.warnings.length > 0) {
    lines.push("", "## Reader warnings", "", ...evidence.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}
