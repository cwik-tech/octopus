import { whenDefined } from "../../core/optional-properties.js"
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  DocumentAnalysisRecord,
  DocumentEvidence,
} from "../../domains/document-reader/types.js";
import { FileSourceRepository } from "../file-sources/file-source-repository.js";
import type {
  FileSourceManifest,
  FileSourceManifestFile,
} from "../file-sources/file-source-types.js";
import { writeFileAtomic, withFileMutationLock } from "../../core/file-mutation.js";
import {
  isSafePathSegment,
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";
import type { SessionFile } from "../../contracts/sessions.js";
import {
  UPLOADABLE_DOCUMENT_EXTENSIONS,
  isUploadableDocumentFilename,
} from "../../contracts/uploadable-formats.js";
import { parsePdfOcrSummary } from "../../file-parser/ocr/contract.js";

export interface TeamUploadFileInput {
  filename: string;
  contents: Buffer;
}

export const TEAM_CONTEXT_MAX_FILES = 8;

/**
 * What a team context document may be, taken from the one list the picker and the 400 also read.
 * Kept identical to the project store's list by construction rather than by anyone remembering.
 */
export const TEAM_CONTEXT_FILE_EXTENSIONS = UPLOADABLE_DOCUMENT_EXTENSIONS;

export type TeamFileSaveResult =
  | { status: "saved"; file: SessionFile }
  | { status: "invalid_filename" }
  | { status: "unsupported_file" }
  | { status: "duplicate_file" }
  | { status: "locked_file" }
  | { status: "file_limit_reached" };

export interface TeamFileTransferResult {
  transferred: number;
}

/** What local OCR did to one uploaded document, as the parse manifest records it. */
export interface TeamFileLocalOcrOutcome {
  status: string;
  /** 1-based pages nothing established a reading for, ascending. */
  unresolvedPages: number[];
  /** True when recognition produced text for at least one page. */
  hasReadPages: boolean;
}

export class TeamFileStoreError extends Error {
  constructor(
    readonly code: "bad_request" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "TeamFileStoreError";
  }
}

interface TeamParsedManifestFile extends FileSourceManifestFile {
  type?: string;
  classification?: string;
  parseQuality?: unknown;
  requiresLlm?: boolean;
  needsOcr?: boolean;
  /** What the file parser's local OCR did. Read as unknown; see `localOcrOutcome`. */
  ocr?: unknown;
  documentAnalysis?: DocumentAnalysisRecord;
}

function expectedPageCount(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== 'object' || !('pages' in metadata)) return undefined;
  return typeof metadata.pages === 'number' && Number.isInteger(metadata.pages) && metadata.pages > 0 ? metadata.pages : undefined;
}

type TeamParsedManifest = FileSourceManifest<TeamParsedManifestFile>;

export interface TeamDocumentReaderInput {
  expectedPageCount?: number;
  name: string;
  contents: Buffer;
  sourceHash: string;
  /** The parsed file type from the manifest, when the parser recorded one. */
  type?: string;
  requiresDocumentReader: boolean;
  documentAnalysis?: DocumentAnalysisRecord;
}

export class TeamFileStore {
  constructor(private readonly workspacePath: string) {}

  private get teamsDir(): string {
    return path.join(this.workspacePath, "team");
  }

  private ownerDir(ownerId: string): string {
    if (!isSafePathSegment(ownerId)) {
      throw new Error("Invalid owner id");
    }
    const resolved = resolveRelativePathInside(this.teamsDir, ownerId);
    if (!resolved) {
      throw new Error("Owner path must stay inside team directory");
    }
    return resolved;
  }

  inputsDir(ownerId: string): string {
    const resolved = resolveRelativePathInside(this.ownerDir(ownerId), "inputs");
    if (!resolved) {
      throw new Error("Inputs path must stay inside owner directory");
    }
    return resolved;
  }

  private fileRepository(
    ownerId: string,
  ): FileSourceRepository<TeamParsedManifestFile> {
    return new FileSourceRepository<TeamParsedManifestFile>({
      rootDir: this.inputsDir(ownerId),
      containmentRoot: this.ownerDir(ownerId),
    });
  }

  async saveUploadedFile(
    ownerId: string,
    input: TeamUploadFileInput,
  ): Promise<TeamFileSaveResult> {
    const filename = sanitizeUploadFilename(input.filename);
    if (!filename) return { status: "invalid_filename" };
    if (!isSupportedTeamContextFilename(filename)) {
      return { status: "unsupported_file" };
    }

    const repository = this.fileRepository(ownerId);
    const targetStatus = await repository.inspectSaveTarget(filename);
    if (targetStatus === "invalid_path") {
      return { status: "invalid_filename" };
    }
    if (targetStatus === "duplicate_file") {
      const existing = (await this.listFiles(ownerId)).find(
        (file) => file.name === filename,
      );
      return {
        status: existing?.usedAt ? "locked_file" : "duplicate_file",
      };
    }
    const existingFiles = await this.listFiles(ownerId);
    if (existingFiles.length >= TEAM_CONTEXT_MAX_FILES) {
      return { status: "file_limit_reached" };
    }

    const result = await repository.save(
      filename,
      input.contents,
      { overwrite: false },
    );
    if (result.status === "invalid_path") {
      return { status: "invalid_filename" };
    }
    if (result.status === "duplicate_file") {
      return { status: "duplicate_file" };
    }
    return { status: "saved", file: result.file };
  }

  async listFiles(ownerId: string): Promise<SessionFile[]> {
    const snapshot = await this.fileRepository(ownerId).readSnapshot();
    return snapshot.files.map((file) => ({
      ...file,
      ...whenDefined(documentAnalysisSummary(
        snapshot.manifest?.files.find((entry) => entry.source === file.name),
      ), (documentAnalysis) => ({ documentAnalysis: documentAnalysis })),
    }));
  }

  async deleteFile(ownerId: string, filename: string): Promise<boolean> {
    return this.fileRepository(ownerId).delete(filename);
  }

  async deleteFileIfUnused(
    ownerId: string,
    filename: string,
  ): Promise<"deleted" | "not_found" | "locked"> {
    return withFileMutationLock(this.inputsDir(ownerId), () =>
      this.fileRepository(ownerId).deleteIfUnused(filename),
    );
  }

  async lockFilesForChat(ownerId: string): Promise<SessionFile[]> {
    return withFileMutationLock(this.inputsDir(ownerId), () =>
      this.fileRepository(ownerId).markCurrentFilesUsed(),
    );
  }

  async transferFiles(params: {
    fromOwnerId: string;
    toOwnerId: string;
    parseDestination?: (inputsDir: string) => Promise<void>;
  }): Promise<TeamFileTransferResult> {
    const { fromOwnerId, toOwnerId, parseDestination } = params;
    if (fromOwnerId === toOwnerId) {
      throw new TeamFileStoreError(
        "bad_request",
        "Document draft and destination must be different",
      );
    }

    const fromInputsDir = this.inputsDir(fromOwnerId);
    const toInputsDir = this.inputsDir(toOwnerId);
    const [firstLock, secondLock] = fromInputsDir < toInputsDir
      ? [fromInputsDir, toInputsDir]
      : [toInputsDir, fromInputsDir];

    return withFileMutationLock(firstLock, async () =>
      withFileMutationLock(secondLock, async () =>
        this.transferFilesLocked({
          fromOwnerId,
          toOwnerId,
          fromInputsDir,
          toInputsDir,
          ...whenDefined(parseDestination, (definedValue) => ({ parseDestination: definedValue })),
        }),
      ),
    );
  }

  async readParsedText(
    ownerId: string,
    outputName: string,
  ): Promise<string | null> {
    return this.fileRepository(ownerId).readParsedText(outputName);
  }

  /**
   * What local OCR did to each of this owner's documents, keyed by filename.
   *
   * A document whose manifest entry carries no recognisable OCR record is absent from the map,
   * which is how a document parsed before local OCR existed is told apart from one that OCR ran
   * on and could not finish.
   */
  async readLocalOcrOutcomes(
    ownerId: string,
  ): Promise<Map<string, TeamFileLocalOcrOutcome>> {
    const manifest = await this.readParsedManifest(ownerId).catch(() => null);
    const outcomes = new Map<string, TeamFileLocalOcrOutcome>();
    for (const entry of manifest?.files ?? []) {
      const outcome = localOcrOutcome(entry);
      if (outcome === null || typeof entry.source !== "string") continue;
      outcomes.set(entry.source, outcome);
    }
    return outcomes;
  }

  async readDocumentReaderInput(
    ownerId: string,
    filename: string,
  ): Promise<TeamDocumentReaderInput | null> {
    if (!isSafePathSegment(filename)) return null;
    const inputsDir = this.inputsDir(ownerId);
    if (!resolveExistingPathInside(this.ownerDir(ownerId), inputsDir)) return null;
    const sourcePath = resolveRelativePathInside(inputsDir, filename);
    if (!sourcePath || !resolveExistingPathInside(inputsDir, sourcePath)) return null;
    const sourceStat = await fs.lstat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) return null;
    const contents = await fs.readFile(sourcePath);
    const manifest = await this.readParsedManifest(ownerId);
    const entry = manifest?.files.find((file) => file.source === filename);
    return {
      name: filename,
      contents,
      sourceHash: sourceHash(contents),
      ...whenDefined(expectedPageCount(entry?.metadata), (expectedPageCount) => ({ expectedPageCount })),
      ...(typeof entry?.type === "string" ? { type: entry.type } : {}),
      requiresDocumentReader: documentReaderRequired(entry),
      ...(entry?.documentAnalysis
        ? { documentAnalysis: entry.documentAnalysis }
        : {}),
    };
  }

  async saveDocumentEvidence(params: {
    ownerId: string;
    filename: string;
    sourceHash: string;
    record: DocumentAnalysisRecord;
    evidence: DocumentEvidence;
    markdown: string;
  }): Promise<void> {
    const { ownerId, filename, sourceHash: hash, record, evidence, markdown } = params;
    if (!isSafePathSegment(filename)) throw new Error("Invalid document filename");
    const inputsDir = this.inputsDir(ownerId);
    await withFileMutationLock(inputsDir, async () => {
      const manifest = await this.readParsedManifest(ownerId);
      const entry = manifest?.files.find((file) => file.source === filename);
      if (!manifest || !entry) throw new Error(`Parsed document is unavailable: ${filename}`);
      const parsedDir = path.join(inputsDir, "parsed");
      if (!resolveExistingPathInside(inputsDir, parsedDir)) {
        throw new Error("Parsed document directory is unavailable");
      }
      const evidenceOutput = `${filename}.evidence.md`;
      const metadataOutput = `${filename}.evidence.json`;
      const evidencePath = resolveRelativePathInside(parsedDir, evidenceOutput);
      const metadataPath = resolveRelativePathInside(parsedDir, metadataOutput);
      if (!evidencePath || !metadataPath) throw new Error("Invalid document evidence path");
      await writeFileAtomic(evidencePath, markdown);
      await writeJsonAtomic(metadataPath, evidence);
      entry.outputs = {
        ...(entry.outputs ?? {}),
        evidence: evidenceOutput,
        evidence_metadata: metadataOutput,
      };
      entry.documentAnalysis = {
        ...record,
        status: "ready",
        sourceHash: hash,
        evidenceOutput,
        metadataOutput,
      };
      await this.writeParsedManifest(ownerId, manifest);
    });
  }

  async saveDocumentAnalysisFailure(params: {
    ownerId: string;
    filename: string;
    sourceHash: string;
    record: DocumentAnalysisRecord;
  }): Promise<void> {
    const { ownerId, filename, sourceHash: hash, record } = params;
    if (!isSafePathSegment(filename)) return;
    const inputsDir = this.inputsDir(ownerId);
    await withFileMutationLock(inputsDir, async () => {
      const manifest = await this.readParsedManifest(ownerId);
      const entry = manifest?.files.find((file) => file.source === filename);
      if (!manifest || !entry) return;
      entry.documentAnalysis = {
        ...record,
        status: "failed",
        sourceHash: hash,
      };
      await this.writeParsedManifest(ownerId, manifest);
    });
  }

  private async transferFilesLocked(params: {
    fromOwnerId: string;
    toOwnerId: string;
    fromInputsDir: string;
    toInputsDir: string;
    parseDestination?: (inputsDir: string) => Promise<void>;
  }): Promise<TeamFileTransferResult> {
    const {
      fromOwnerId,
      toOwnerId,
      fromInputsDir,
      toInputsDir,
      parseDestination,
    } = params;
    if (
      !existsSync(fromInputsDir) ||
      !resolveExistingPathInside(this.ownerDir(fromOwnerId), fromInputsDir)
    ) {
      return { transferred: 0 };
    }

    await fs.mkdir(toInputsDir, { recursive: true });
    if (!resolveExistingPathInside(this.ownerDir(toOwnerId), toInputsDir)) {
      throw new TeamFileStoreError(
        "bad_request",
        "Destination document directory is invalid",
      );
    }

    const files = await this.listFiles(fromOwnerId);
    if (files.length === 0) return { transferred: 0 };

    const existingDestinationEntries = await fs.readdir(toInputsDir);
    if (existingDestinationEntries.length > 0) {
      throw new TeamFileStoreError(
        "conflict",
        "Destination already contains uploaded documents",
      );
    }

    try {
      for (const file of files) {
        const sourcePath = resolveRelativePathInside(fromInputsDir, file.name);
        const destinationPath = resolveRelativePathInside(toInputsDir, file.name);
        if (!sourcePath || !destinationPath) {
          throw new TeamFileStoreError(
            "bad_request",
            "Uploaded document path is invalid",
          );
        }
        const sourceStat = await fs.lstat(sourcePath);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
          throw new TeamFileStoreError(
            "bad_request",
            `Uploaded document is unavailable: ${file.name}`,
          );
        }
        await writeFileAtomic(destinationPath, await fs.readFile(sourcePath));
      }
      await parseDestination?.(toInputsDir);
      await this.copyDocumentEvidence({
        fromOwnerId,
        toOwnerId,
        fromInputsDir,
        toInputsDir,
      });
    } catch (error) {
      await fs.rm(toInputsDir, { recursive: true, force: true });
      throw error;
    }

    await fs.rm(fromInputsDir, { recursive: true, force: true });
    return { transferred: files.length };
  }

  private async readParsedManifest(
    ownerId: string,
  ): Promise<TeamParsedManifest | null> {
    return this.fileRepository(ownerId).readManifest();
  }

  private async writeParsedManifest(
    ownerId: string,
    manifest: TeamParsedManifest,
  ): Promise<void> {
    await this.fileRepository(ownerId).writeManifest(manifest);
  }

  private async copyDocumentEvidence(params: {
    fromOwnerId: string;
    toOwnerId: string;
    fromInputsDir: string;
    toInputsDir: string;
  }): Promise<void> {
    const fromManifest = await this.readParsedManifest(params.fromOwnerId);
    const toManifest = await this.readParsedManifest(params.toOwnerId);
    if (!fromManifest || !toManifest) return;
    const fromParsedDir = path.join(params.fromInputsDir, "parsed");
    const toParsedDir = path.join(params.toInputsDir, "parsed");
    const containedFrom = resolveExistingPathInside(params.fromInputsDir, fromParsedDir);
    const containedTo = resolveExistingPathInside(params.toInputsDir, toParsedDir);
    if (!containedFrom || !containedTo) return;

    let changed = false;
    for (const sourceEntry of fromManifest.files) {
      const analysis = sourceEntry.documentAnalysis;
      if (analysis?.status !== "ready" || !analysis.evidenceOutput || !analysis.metadataOutput) {
        continue;
      }
      const destinationEntry = toManifest.files.find((file) => file.source === sourceEntry.source);
      if (!destinationEntry) continue;
      const sourceEvidence = resolveRelativePathInside(containedFrom, analysis.evidenceOutput);
      const sourceMetadata = resolveRelativePathInside(containedFrom, analysis.metadataOutput);
      const destinationEvidence = resolveRelativePathInside(containedTo, analysis.evidenceOutput);
      const destinationMetadata = resolveRelativePathInside(containedTo, analysis.metadataOutput);
      if (!sourceEvidence || !sourceMetadata || !destinationEvidence || !destinationMetadata) continue;
      if (!resolveExistingPathInside(containedFrom, sourceEvidence) || !resolveExistingPathInside(containedFrom, sourceMetadata)) continue;
      await writeFileAtomic(destinationEvidence, await fs.readFile(sourceEvidence));
      await writeFileAtomic(destinationMetadata, await fs.readFile(sourceMetadata));
      destinationEntry.outputs = {
        ...(destinationEntry.outputs ?? {}),
        evidence: analysis.evidenceOutput,
        evidence_metadata: analysis.metadataOutput,
      };
      destinationEntry.documentAnalysis = analysis;
      changed = true;
    }
    if (changed) await this.writeParsedManifest(params.toOwnerId, toManifest);
  }
}

function documentAnalysisSummary(
  entry: TeamParsedManifestFile | undefined,
): SessionFile["documentAnalysis"] {
  if (!entry) return undefined;
  const analysis = entry.documentAnalysis;
  if (analysis) {
    return {
      status: analysis.status,
      ...(analysis.provider ? { provider: analysis.provider } : {}),
      ...(analysis.model ? { model: analysis.model } : {}),
      ...(analysis.error ? { error: analysis.error } : {}),
    };
  }
  return documentReaderRequired(entry) ? { status: "required" } : { status: "not_needed" };
}

/**
 * What local OCR did to this document, when the manifest says so in the shape this package
 * writes.
 *
 * The manifest is persisted external input: it may have been written by an older parser, by a
 * newer one, or by hand. Well-formedness is decided by the contract's own validator
 * (`parsePdfOcrSummary` in file-parser/ocr/contract.ts), which fails closed: anything that is
 * not the expected shape is `null`, which routes the document exactly as it was routed before
 * local OCR existed.
 */
function localOcrOutcome(
  entry: TeamParsedManifestFile | undefined,
): TeamFileLocalOcrOutcome | null {
  const summary = parsePdfOcrSummary(entry?.ocr);
  if (summary === null) return null;
  return {
    status: summary.status,
    unresolvedPages: summary.unresolvedPages,
    hasReadPages: summary.readPages.length > 0,
  };
}

function documentReaderRequired(
  entry: TeamParsedManifestFile | undefined,
): boolean {
  if (entry?.type !== "pdf") return false;
  // A page the extractor could not read is not a missing page once local OCR read it. The
  // pre-recognition signals stay exactly as they were; what changes is that a document local
  // OCR resolved completely no longer needs a remote reader to be usable.
  const ocr = localOcrOutcome(entry);
  if (ocr !== null && ocr.status === "complete" && ocr.unresolvedPages.length === 0) {
    return false;
  }
  if (
    entry.needsOcr === true ||
    entry.classification === "scanned" ||
    entry.classification === "visual"
  ) {
    return true;
  }
  if (entry.requiresLlm !== true) return false;

  return !hasCompleteDeterministicPdfText(entry);
}

function hasCompleteDeterministicPdfText(
  entry: TeamParsedManifestFile,
): boolean {
  return (
    entry.classification === "text-heavy" &&
    entry.parseQuality === "high" &&
    reportsNoEncodingIssues(entry["metadata"])
  );
}

function reportsNoEncodingIssues(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "has_encoding_issues" in value &&
    value.has_encoding_issues === false
  );
}

function sourceHash(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function sanitizeUploadFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base = path
    .basename(value)
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 200);
  if (base.length === 0 || base === "." || base === "..") return null;
  return base;
}

function isSupportedTeamContextFilename(filename: string): boolean {
  return isUploadableDocumentFilename(filename);
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  );
}

export { withFileMutationLock };
