import { whenDefined } from "../../core/optional-properties.js"
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { publishRuntimeArtifactWrittenEvent } from "../runtime/artifacts.js";
import {
  isSafePathSegment,
  resolveRelativePathInside,
} from "../../core/path-safety.js";
import {
  isSupportedSourceObservationReceiptVersion,
  receiptStoresStructuredRepresentations,
  SOURCE_OBSERVATION_RECEIPT_VERSION,
  type AcquisitionAttempt,
  type AcquisitionContentMatchView,
  type AcquisitionContentView,
  type AcquisitionMethod,
  type SourceObservationReceipt,
  type SourceObservationReceiptView,
} from "./acquisition-types.js";
import { canonicalizeSourceUrl } from "./acquisition-url.js";
import type {
  SourceRepresentationManifest,
  SourceStructuredRepresentation,
} from "./source-representations.js";
import type { AcquisitionQualityReport } from "./acquisition-quality.js";

const CHUNK_BYTES = 24 * 1_024;
const MAX_CONTENT_BYTES = 10 * 1_024 * 1_024;
const MAX_MATCHES = 20;
const MAX_SNIPPET_CHARS = 400;

export interface ObservationIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly activityScopeId: string;
  readonly agentPath: string;
  readonly agentDisplayName?: string;
}

export interface PersistSourceObservationInput {
  readonly assignmentPath: string;
  readonly identity: ObservationIdentity;
  readonly activityId: string;
  readonly method: AcquisitionMethod;
  readonly provider?: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly mediaType: string;
  readonly content: string;
  readonly structuredRepresentations?: readonly SourceStructuredRepresentation[];
  readonly representationWarnings?: readonly string[];
  readonly qualityReport?: AcquisitionQualityReport;
  readonly rawSource?: {
    readonly bytes: Uint8Array;
    readonly fileExtension: string;
    readonly mediaType: string;
    readonly truncated?: boolean;
  };
  readonly rawOmissionReason?: string;
  readonly attempts: readonly AcquisitionAttempt[];
  readonly observedAt?: string;
}

export interface PersistedSourceObservation {
  readonly receipt: SourceObservationReceipt;
  readonly view: SourceObservationReceiptView;
  readonly content: AcquisitionContentView;
}

export interface StoredSourceObservationPackage {
  readonly receiptId: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly receipt:
    | SourceObservationReceipt
    | {
        readonly schemaVersion: 1;
        readonly receiptId: string;
        readonly contentRelativePath: string;
        readonly contentSha256: string;
        readonly contentBytes: number;
      };
  readonly representations: SourceRepresentationManifest;
}

export class SourceObservationStore {
  async persist(
    input: PersistSourceObservationInput,
  ): Promise<PersistedSourceObservation> {
    assertIdentity(input.identity);
    if (!isSafePathSegment(input.activityId)) {
      throw new Error("Acquisition activity ID is invalid.");
    }
    const assignmentPath = path.resolve(input.assignmentPath);
    await assertRegularDirectory(assignmentPath);
    const normalized = normalizeContent(input.content);
    const contentBytes = Buffer.byteLength(normalized, "utf8");
    if (contentBytes < 1 || contentBytes > MAX_CONTENT_BYTES) {
      throw new Error(
        "Acquired content is outside the 1 byte through 10 MB limit.",
      );
    }
    const observedAt = input.observedAt ?? new Date().toISOString();
    if (new Date(observedAt).toISOString() !== observedAt) {
      throw new Error("Observation time must be a canonical ISO timestamp.");
    }
    const requestedUrl = canonicalizeSourceUrl(input.requestedUrl);
    const finalUrl = canonicalizeSourceUrl(input.finalUrl);
    const canonicalUrl = canonicalizeSourceUrl(
      input.canonicalUrl ?? input.finalUrl,
    );
    const contentRelativePath = [
      "research",
      "acquisitions",
      input.identity.activityScopeId,
      input.activityId,
      "content.md",
    ].join("/");
    const receiptRelativePath = [
      "research",
      "observations",
      input.identity.activityScopeId,
      `${input.activityId}.json`,
    ].join("/");
    const packageRelativePath = [
      "research",
      "acquisitions",
      input.identity.activityScopeId,
      input.activityId,
    ].join("/");
    const sourceMetadataRelativePath = `${packageRelativePath}/source-metadata.json`;
    const representationsRelativePath = `${packageRelativePath}/representations.json`;
    const contentBuffer = Buffer.from(normalized, "utf8");
    await writeExclusiveFile(
      assignmentPath,
      contentRelativePath,
      contentBuffer,
    );
    const contentSha256 = createHash("sha256").update(normalized).digest("hex");
    const qualityReport =
      input.qualityReport ?? defaultQualityReport(normalized);
    const sourceMetadataBuffer = jsonBuffer({
      schemaVersion: 1,
      requestedUrl,
      finalUrl,
      canonicalUrl,
      ...(input.title?.trim()
        ? { title: input.title.trim().slice(0, 1_000) }
        : {}),
      sourceMediaType: normalizeMediaType(input.mediaType),
      normalizedMediaType: "text/markdown",
      observedAt,
      method: input.method,
      ...(input.provider ? { provider: input.provider } : {}),
      quality: qualityReport,
    });
    const representationsManifest: SourceRepresentationManifest = {
      schemaVersion: 1,
      sourceMediaType: normalizeMediaType(input.mediaType),
      normalizedMediaType: "text/markdown",
      contentRelativePath,
      contentSha256,
      contentBytes,
      representations: input.structuredRepresentations ?? [],
      warnings: input.representationWarnings ?? [],
    };
    const representationsBuffer = compactJsonBuffer(representationsManifest);
    await writeExclusiveFile(
      assignmentPath,
      sourceMetadataRelativePath,
      sourceMetadataBuffer,
    );
    await writeExclusiveFile(
      assignmentPath,
      representationsRelativePath,
      representationsBuffer,
    );
    let rawSource: SourceObservationReceipt["rawSource"] | undefined;
    if (input.rawSource) {
      if (
        input.rawSource.bytes.byteLength < 1 ||
        input.rawSource.bytes.byteLength > MAX_CONTENT_BYTES
      ) {
        throw new Error(
          "Raw source is outside the 1 byte through 10 MB limit.",
        );
      }
      const extension = safeRawExtension(input.rawSource.fileExtension);
      const rawRelativePath = `${packageRelativePath}/raw/source${extension}`;
      const rawBuffer = Buffer.from(input.rawSource.bytes);
      await writeExclusiveFile(assignmentPath, rawRelativePath, rawBuffer);
      rawSource = {
        relativePath: rawRelativePath,
        sha256: sha256(rawBuffer),
        bytes: rawBuffer.byteLength,
        mediaType: normalizeMediaType(input.rawSource.mediaType),
        ...(input.rawSource.truncated ? { truncated: true } : {}),
      };
    }
    const receipt: SourceObservationReceipt = {
      schemaVersion: SOURCE_OBSERVATION_RECEIPT_VERSION,
      receiptId: input.activityId,
      ...input.identity,
      activityId: input.activityId,
      method: input.method,
      ...(input.provider ? { provider: input.provider } : {}),
      requestedUrl,
      finalUrl,
      canonicalUrl,
      ...(input.title?.trim()
        ? { title: input.title.trim().slice(0, 1_000) }
        : {}),
      mediaType: normalizeMediaType(input.mediaType),
      normalizedMediaType: "text/markdown",
      observedAt,
      contentRelativePath,
      contentSha256,
      contentBytes,
      quality: "usable",
      qualityReport,
      sourceMetadata: artifactReference(
        sourceMetadataRelativePath,
        sourceMetadataBuffer,
      ),
      representations: artifactReference(
        representationsRelativePath,
        representationsBuffer,
      ),
      ...(rawSource ? { rawSource } : {}),
      ...(!rawSource
        ? {
            rawOmissionReason: normalizeOmissionReason(
              input.rawOmissionReason ??
                "The acquisition method did not expose a raw source representation.",
            ),
          }
        : {}),
      attempts: input.attempts,
    };
    await writeExclusiveFile(
      assignmentPath,
      receiptRelativePath,
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
    );
    publishRuntimeArtifactWrittenEvent({
      outputDir: assignmentPath,
      relativePath: receiptRelativePath,
      artifactType: "observation-receipt",
      artifactRole: "intermediate",
      createdAt: observedAt,
      sessionId: input.identity.assignmentId,
      rootSessionId: input.identity.runId,
      agentId: input.identity.activityScopeId,
      agentName:
        input.identity.agentDisplayName ?? input.identity.activityScopeId,
      ...whenDefined(input.identity.agentPath.split("/").at(-1), (definedValue) => ({ agentBaseName: definedValue })),
      activityScopeId: input.identity.activityScopeId,
      emitterName: "source-observation-store",
      title: `Source observation ${receipt.receiptId}`,
    });
    const chunks = chunkUtf8(normalized, CHUNK_BYTES);
    return {
      receipt,
      view: {
        schemaVersion: SOURCE_OBSERVATION_RECEIPT_VERSION,
        receiptId: receipt.receiptId,
        activityId: receipt.activityId,
        activityScopeId: receipt.activityScopeId,
        relativePath: receiptRelativePath,
        method: receipt.method,
        ...(receipt.provider ? { provider: receipt.provider } : {}),
        requestedUrl: receipt.requestedUrl,
        finalUrl: receipt.finalUrl,
        canonicalUrl: receipt.canonicalUrl,
        observedAt: receipt.observedAt,
        contentRelativePath: receipt.contentRelativePath,
        contentSha256: receipt.contentSha256,
        contentBytes: receipt.contentBytes,
        quality: receipt.qualityReport.status,
        representationsRelativePath: receipt.representations.relativePath,
        ...(receipt.rawSource
          ? { rawSourceRelativePath: receipt.rawSource.relativePath }
          : {}),
      },
      content: {
        id: receipt.receiptId,
        sizeBytes: receipt.contentBytes,
        chunkCount: chunks.length,
        currentChunk: 0,
        text: chunks[0] ?? "",
      },
    };
  }

  async read(params: {
    readonly assignmentPath: string;
    readonly activityScopeId: string;
    readonly contentId: string;
    readonly chunkIndex?: number;
  }): Promise<AcquisitionContentView | null> {
    const content = await this.readContent(params);
    if (!content) return null;
    const chunks = chunkUtf8(content, CHUNK_BYTES);
    const chunkIndex = params.chunkIndex ?? 0;
    if (
      !Number.isSafeInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= chunks.length
    ) {
      return null;
    }
    return {
      id: params.contentId,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      chunkCount: chunks.length,
      currentChunk: chunkIndex,
      text: chunks[chunkIndex] ?? "",
    };
  }

  async search(params: {
    readonly assignmentPath: string;
    readonly activityScopeId: string;
    readonly contentId: string;
    readonly query: string;
  }): Promise<readonly AcquisitionContentMatchView[] | null> {
    const content = await this.readContent(params);
    if (!content) return null;
    const needle = params.query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const matches: AcquisitionContentMatchView[] = [];
    for (const [chunkIndex, chunk] of chunkUtf8(
      content,
      CHUNK_BYTES,
    ).entries()) {
      const lower = chunk.toLocaleLowerCase();
      let offset = lower.indexOf(needle);
      while (offset >= 0 && matches.length < MAX_MATCHES) {
        const start = Math.max(0, offset - Math.floor(MAX_SNIPPET_CHARS / 2));
        const end = Math.min(
          chunk.length,
          offset + needle.length + Math.floor(MAX_SNIPPET_CHARS / 2),
        );
        matches.push({
          chunkIndex,
          snippet: [
            start > 0 ? "…" : "",
            chunk.slice(start, end).replace(/\s+/gu, " ").trim(),
            end < chunk.length ? "…" : "",
          ].join(""),
        });
        offset = lower.indexOf(needle, offset + Math.max(needle.length, 1));
      }
      if (matches.length >= MAX_MATCHES) break;
    }
    return matches;
  }

  async readPackage(params: {
    readonly assignmentPath: string;
    readonly activityScopeId: string;
    readonly contentId: string;
  }): Promise<StoredSourceObservationPackage | null> {
    if (
      !isSafePathSegment(params.activityScopeId) ||
      !isSafePathSegment(params.contentId)
    ) {
      return null;
    }
    const assignmentPath = path.resolve(params.assignmentPath);
    const receiptRelativePath = [
      "research",
      "observations",
      params.activityScopeId,
      `${params.contentId}.json`,
    ].join("/");
    try {
      const receiptBuffer = await readRegularFile(
        assignmentPath,
        receiptRelativePath,
        256 * 1_024,
      );
      const receipt = JSON.parse(receiptBuffer.toString("utf8")) as Record<
        string,
        unknown
      >;
      if (
        receipt.receiptId !== params.contentId ||
        receipt.activityScopeId !== params.activityScopeId ||
        !isSupportedSourceObservationReceiptVersion(receipt.schemaVersion) ||
        typeof receipt.contentRelativePath !== "string" ||
        typeof receipt.contentSha256 !== "string" ||
        typeof receipt.contentBytes !== "number"
      ) {
        return null;
      }
      const expectedContentPath = [
        "research",
        "acquisitions",
        params.activityScopeId,
        params.contentId,
        "content.md",
      ].join("/");
      if (receipt.contentRelativePath !== expectedContentPath) return null;
      const contentBuffer = await readRegularFile(
        assignmentPath,
        receipt.contentRelativePath,
        MAX_CONTENT_BYTES,
      );
      if (
        contentBuffer.byteLength !== receipt.contentBytes ||
        sha256(contentBuffer) !== receipt.contentSha256
      ) {
        throw new Error("Stored source content failed integrity verification.");
      }
      let representations: SourceRepresentationManifest = {
        schemaVersion: 1,
        sourceMediaType:
          typeof receipt.mediaType === "string"
            ? receipt.mediaType
            : "text/plain",
        normalizedMediaType: "text/markdown",
        contentRelativePath: receipt.contentRelativePath,
        contentSha256: receipt.contentSha256,
        contentBytes: receipt.contentBytes,
        representations: [],
        warnings: [
          "This legacy observation predates stored structured representations.",
        ],
      };
      if (
        isSupportedSourceObservationReceiptVersion(receipt.schemaVersion) &&
        receiptStoresStructuredRepresentations(receipt.schemaVersion)
      ) {
        const representationRef = artifactReferenceFromReceipt(
          receipt.representations,
        );
        const metadataRef = artifactReferenceFromReceipt(
          receipt.sourceMetadata,
        );
        const expectedPackagePath = [
          "research",
          "acquisitions",
          params.activityScopeId,
          params.contentId,
        ].join("/");
        if (
          !representationRef ||
          !metadataRef ||
          representationRef.relativePath !==
            `${expectedPackagePath}/representations.json` ||
          metadataRef.relativePath !==
            `${expectedPackagePath}/source-metadata.json`
        ) {
          throw new Error(
            "Stored source package failed integrity verification.",
          );
        }
        await readVerifiedArtifact(
          assignmentPath,
          metadataRef,
          512 * 1_024,
          "Stored source metadata",
        );
        const manifestBuffer = await readVerifiedArtifact(
          assignmentPath,
          representationRef,
          3 * 1_024 * 1_024,
          "Stored source representations",
        );
        representations = validateRepresentationManifest(
          JSON.parse(manifestBuffer.toString("utf8")),
          {
            contentRelativePath: receipt.contentRelativePath,
            contentSha256: receipt.contentSha256,
            contentBytes: receipt.contentBytes,
          },
        );
        if (receipt.rawSource !== undefined) {
          const rawRef = artifactReferenceFromReceipt(receipt.rawSource);
          if (
            !rawRef ||
            !new RegExp(
              `^${escapeRegExp(expectedPackagePath)}/raw/source\\.[a-z0-9]{1,10}$`,
              "u",
            ).test(rawRef.relativePath)
          ) {
            throw new Error("Stored raw source failed integrity verification.");
          }
          await readVerifiedArtifact(
            assignmentPath,
            rawRef,
            MAX_CONTENT_BYTES,
            "Stored raw source",
          );
        }
      }
      return {
        receiptId: params.contentId,
        content: contentBuffer.toString("utf8"),
        contentSha256: receipt.contentSha256,
        receipt: receipt as StoredSourceObservationPackage["receipt"],
        representations,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /integrity verification/u.test(error.message)
      ) {
        throw error;
      }
      return null;
    }
  }

  private async readContent(params: {
    readonly assignmentPath: string;
    readonly activityScopeId: string;
    readonly contentId: string;
  }): Promise<string | null> {
    if (
      !isSafePathSegment(params.activityScopeId) ||
      !isSafePathSegment(params.contentId)
    ) {
      return null;
    }
    const assignmentPath = path.resolve(params.assignmentPath);
    const relativePath = [
      "research",
      "acquisitions",
      params.activityScopeId,
      params.contentId,
      "content.md",
    ].join("/");
    const target = resolveRelativePathInside(assignmentPath, relativePath);
    if (!target) return null;
    try {
      const [stat, real] = await Promise.all([
        fs.lstat(target),
        fs.realpath(target),
      ]);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size < 1 ||
        stat.size > MAX_CONTENT_BYTES ||
        real !== target ||
        (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
      ) {
        return null;
      }
      return fs.readFile(target, "utf8");
    } catch {
      return null;
    }
  }
}

async function writeExclusiveFile(
  assignmentPath: string,
  relativePath: string,
  contents: Buffer,
): Promise<void> {
  const target = resolveRelativePathInside(assignmentPath, relativePath);
  if (!target) throw new Error("Observation artifact path is unsafe.");
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const directoryReal = await fs.realpath(directory);
  if (
    directoryReal !== directory ||
    !directoryReal.startsWith(`${assignmentPath}${path.sep}`)
  ) {
    throw new Error("Observation artifact directory is unsafe.");
  }
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(contents);
    await handle.sync();
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size !== contents.byteLength ||
      (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
    ) {
      throw new Error("Observation artifact could not be verified.");
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertRegularDirectory(directory: string): Promise<void> {
  const [stat, real] = await Promise.all([
    fs.lstat(directory),
    fs.realpath(directory),
  ]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== directory) {
    throw new Error("Research assignment must be a regular directory.");
  }
}

function assertIdentity(identity: ObservationIdentity): void {
  for (const value of [
    identity.sessionId,
    identity.runId,
    identity.assignmentId,
    identity.activityScopeId,
  ]) {
    if (!isSafePathSegment(value)) {
      throw new Error("Observation runtime identity is invalid.");
    }
  }
  if (!identity.agentPath.trim() || identity.agentPath.includes("\0")) {
    throw new Error("Observation agent path is invalid.");
  }
}

function normalizeContent(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

function normalizeMediaType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType || "text/plain";
}

function defaultQualityReport(content: string): AcquisitionQualityReport {
  return {
    status: "usable",
    score: 100,
    signals: [],
    readableCharacters: content.length,
    uniqueWordRatio: 1,
    structuredRepresentationCount: 0,
  };
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function compactJsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactReference(relativePath: string, value: Buffer) {
  return {
    relativePath,
    sha256: sha256(value),
    bytes: value.byteLength,
  };
}

function artifactReferenceFromReceipt(value: unknown): {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.relativePath === "string" &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.sha256) &&
    Number.isSafeInteger(record.bytes) &&
    Number(record.bytes) > 0
    ? (record as {
        relativePath: string;
        sha256: string;
        bytes: number;
      })
    : null;
}

function safeRawExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(normalized) ? normalized : ".bin";
}

function normalizeOmissionReason(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, 1_000);
}

async function readRegularFile(
  assignmentPath: string,
  relativePath: string,
  maximumBytes: number,
): Promise<Buffer> {
  const target = resolveRelativePathInside(assignmentPath, relativePath);
  if (!target) throw new Error("Stored source artifact path is unsafe.");
  const [stat, real] = await Promise.all([
    fs.lstat(target),
    fs.realpath(target),
  ]);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > maximumBytes ||
    real !== target ||
    (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
  ) {
    throw new Error("Stored source artifact is unavailable.");
  }
  return fs.readFile(target);
}

async function readVerifiedArtifact(
  assignmentPath: string,
  reference: {
    readonly relativePath: string;
    readonly sha256: string;
    readonly bytes: number;
  },
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  let value: Buffer;
  try {
    value = await readRegularFile(
      assignmentPath,
      reference.relativePath,
      maximumBytes,
    );
  } catch {
    throw new Error(`${label} failed integrity verification.`);
  }
  if (
    value.byteLength !== reference.bytes ||
    sha256(value) !== reference.sha256
  ) {
    throw new Error(`${label} failed integrity verification.`);
  }
  return value;
}

function validateRepresentationManifest(
  value: unknown,
  expected: {
    readonly contentRelativePath: string;
    readonly contentSha256: string;
    readonly contentBytes: number;
  },
): SourceRepresentationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Stored source representations failed integrity verification.",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.sourceMediaType !== "string" ||
    record.normalizedMediaType !== "text/markdown" ||
    record.contentRelativePath !== expected.contentRelativePath ||
    record.contentSha256 !== expected.contentSha256 ||
    record.contentBytes !== expected.contentBytes ||
    !Array.isArray(record.representations) ||
    record.representations.length > 200 ||
    !Array.isArray(record.warnings) ||
    record.warnings.length > 100 ||
    record.warnings.some(
      (warning) => typeof warning !== "string" || warning.length > 2_000,
    ) ||
    record.representations.some(
      (representation) => !isStoredRepresentation(representation),
    )
  ) {
    throw new Error(
      "Stored source representations failed integrity verification.",
    );
  }
  return {
    schemaVersion: 1,
    sourceMediaType: record.sourceMediaType,
    normalizedMediaType: "text/markdown",
    contentRelativePath: record.contentRelativePath,
    contentSha256: record.contentSha256,
    contentBytes: record.contentBytes,
    representations: record.representations.map(parseStoredRepresentation),
    // Every entry was checked to be a string above; the guard carries that
    // check into the type.
    warnings: record.warnings.filter(
      (warning): warning is string => typeof warning === "string",
    ),
  };
}

function isStoredRepresentation(
  value: unknown,
): value is SourceStructuredRepresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return parseStoredRepresentationOrNull(record) !== null;
}

function parseStoredRepresentation(
  value: unknown,
): SourceStructuredRepresentation {
  const parsed = parseStoredRepresentationOrNull(value);
  if (!parsed)
    throw new Error(
      "Stored source representations failed integrity verification.",
    );
  return parsed;
}

function parseStoredRepresentationOrNull(
  value: unknown,
): SourceStructuredRepresentation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > 160 ||
    (kind !== "metadata" &&
      kind !== "json" &&
      kind !== "json-ld" &&
      kind !== "application-state" &&
      kind !== "table" &&
      kind !== "microdata") ||
    record.mediaType !== "application/json" ||
    !("data" in record)
  )
    return null;
  return {
    id: record.id,
    kind,
    mediaType: "application/json",
    data: record.data,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function chunkUtf8(value: string, maximumBytes: number): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (current && bytes + characterBytes > maximumBytes) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}
