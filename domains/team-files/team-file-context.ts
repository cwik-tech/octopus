import { whenDefined } from "../../core/optional-properties.js"
import type { ResourceReferenceDocument } from "../../contracts/resource-architect.js";
import {
  ensureTeamDocumentEvidence,
} from "../../domains/document-reader/team-document-analysis.js";
import type { DocumentReaderSelection } from "../../domains/document-reader/types.js";
import { TEAM_CONTEXT_MAX_FILES, TeamFileStore } from "./team-file-store.js";
import { createDocumentSource } from '../document-access/document-source.js';
import { parseDocumentEvidence } from '../document-reader/document-reader.js';
import { pdfPageIndexSchema } from '../../contracts/document-reference.js';
import * as path from 'node:path';
import type { FileParserLauncher } from '../../core/file-parser-launcher.js';
import { parseDocumentCopy } from '../document-access/copied-document-parser.js';

export const TEAM_CONTEXT_MAX_CHARS = 60_000;

export interface TeamFileContext {
  reviewCacheDir?: string;
  documents: ResourceReferenceDocument[];
  warnings: string[];
}

export async function readTeamFileContext(
  store: TeamFileStore,
  ownerId: string | undefined,
  options: {
    documentReader?: DocumentReaderSelection;
    signal?: AbortSignal;
    parserLauncher?: FileParserLauncher;
    requirePageIndex?: boolean;
  } = {},
): Promise<TeamFileContext> {
  if (!ownerId) return { documents: [], warnings: [] };

  // Freeze the exact revisions before either the document reader or Team
  // Architect provider can receive their contents.
  const locked = await store.lockFilesForChat(ownerId);

  const warnings = await ensureTeamDocumentEvidence({
    store,
    ownerId,
    ...whenDefined(options.documentReader, (definedValue) => ({ selection: definedValue })),
    ...whenDefined(options.signal, (definedValue) => ({ signal: definedValue })),
  });
  const files = await store.listFiles(ownerId);
  // What local OCR resolved, so a document it read in part keeps its readable pages instead of
  // being dropped whole while a reader is requested for the rest.
  const localOcr = await store.readLocalOcrOutcomes(ownerId);
  const documents: ResourceReferenceDocument[] = [];
  let charactersUsed = 0;
  let omittedForFileLimit = 0;

  for (const file of files) {
    if (documents.length >= TEAM_CONTEXT_MAX_FILES) {
      omittedForFileLimit += 1;
      continue;
    }
    if (file.parseStatus === "error") {
      warnings.push(`${file.name} could not be parsed and was not used.`);
      continue;
    }
    const ocrOutcome =
      file.documentAnalysis?.status === "required" || file.documentAnalysis?.status === "failed"
        ? localOcr.get(file.name)
        : undefined;
    if (file.documentAnalysis?.status === "required" && !ocrOutcome?.hasReadPages) {
      warnings.push(`${file.name} needs a document reader and was not used.`);
      continue;
    }
    if (file.documentAnalysis?.status === "failed" && !ocrOutcome?.hasReadPages) {
      warnings.push(`${file.name} could not be read by the document reader and was not used.`);
      continue;
    }
    if (ocrOutcome?.hasReadPages) {
      const unresolved =
        ocrOutcome.unresolvedPages.length > 0
          ? `page${ocrOutcome.unresolvedPages.length === 1 ? "" : "s"} ${ocrOutcome.unresolvedPages.join(", ")} remain unresolved`
          : undefined;
      if (file.documentAnalysis?.status === "failed") {
        // A failed remote read does not delete or replace what local OCR already read.
        warnings.push(
          `${file.name} could not be read by the document reader${unresolved ? `, and ${unresolved}` : ""}. The pages that were read locally are included.`,
        );
      } else {
        warnings.push(
          `${file.name} could not be read in full: ${
            unresolved ?? "some pages remain unresolved"
          }. The pages that were read are included.`,
        );
      }
    }
    const textOutput = file.documentAnalysis?.status === "ready"
      ? file.outputs?.evidence
      : file.outputs?.text;
    if (!textOutput) {
      warnings.push(`${file.name} has no usable text and was not used.`);
      continue;
    }

    let content: string | null;
    try {
      content = await store.readParsedText(ownerId, textOutput);
    } catch {
      warnings.push(`${file.name} could not be read and was not used.`);
      continue;
    }
    if (!content) {
      warnings.push(`${file.name} has no readable parsed text and was not used.`);
      continue;
    }

    const remainingCharacters = TEAM_CONTEXT_MAX_CHARS - charactersUsed;
    const usedContent = content.slice(0, Math.max(0, remainingCharacters));
    const indexText = file.outputs?.parse ? await store.readParsedText(ownerId, file.outputs.parse) : null;
    const index = indexText ? pdfPageIndexSchema.safeParse(JSON.parse(indexText)) : undefined;
    let pages = index?.success ? index.data.pages : undefined;
    if (!pages && options.requirePageIndex && file.name.toLowerCase().endsWith('.pdf') && options.parserLauncher) {
      const original = await store.readDocumentReaderInput(ownerId, file.name);
      if (!original) throw new Error('Locked PDF original is unavailable');
      const parsed = await parseDocumentCopy({ name: file.name, contents: original.contents, launcher: options.parserLauncher, ...whenDefined(options.signal, (signal) => ({ signal })) });
      pages = parsed.pages;
    }
    if (file.documentAnalysis?.status === 'ready' && file.outputs?.evidence_metadata) {
      const evidenceText = await store.readParsedText(ownerId, file.outputs.evidence_metadata);
      if (!evidenceText) throw new Error('Validated document evidence is unavailable');
      const evidence = parseDocumentEvidence(JSON.parse(evidenceText), pages?.length);
      const indexed = pdfPageIndexSchema.safeParse({ page_count: evidence.pages.length, pages: [...evidence.pages].sort((left, right) => left.page - right.page).map((page) => ({ page: page.page, markdown: [page.content, page.tableMarkdown ?? '', ...page.keyFacts].filter(Boolean).join('\n\n'), status: page.unreadable ? 'unresolved' : 'read' })) });
      pages = indexed.success ? indexed.data.pages : undefined;
    }
    // The first use recorded for this exact revision. A file replaced after
    // the lock matches nothing and carries no provenance.
    const revision = locked.find(
      (entry) => entry.name === file.name && entry.uploadedAt === file.uploadedAt,
    );
    documents.push({
      documentSource: createDocumentSource({ owner: ownerId, name: file.name, text: content, revisionKey: file.uploadedAt, uploadedAt: file.uploadedAt, ...whenDefined(pages, (pages) => ({ pages })) }),
      name: file.name,
      content: usedContent,
      ...whenDefined(revision?.uploadedAt, (uploadedAt) => ({ uploadedAt })),
      ...whenDefined(revision?.usedAt, (usedAt) => ({ usedAt })),
    });
    charactersUsed += usedContent.length;
    if (usedContent.length < content.length) {
      warnings.push(
        `${file.name} has an excerpt truncated to keep document context within ${TEAM_CONTEXT_MAX_CHARS.toLocaleString()} characters.`,
      );
    }
  }

  if (omittedForFileLimit > 0) {
    warnings.push(
      `${omittedForFileLimit} document${omittedForFileLimit === 1 ? " was" : "s were"} not used because Team Architect accepts at most ${TEAM_CONTEXT_MAX_FILES} context documents.`,
    );
  }


  return { documents, warnings, reviewCacheDir: path.join(path.dirname(store.inputsDir(ownerId)), 'document-review') };
}
