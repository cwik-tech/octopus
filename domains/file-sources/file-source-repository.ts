import { whenDefined } from "../../core/optional-properties.js"
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  throwIfSignalAborted,
  writeFileAtomic,
} from "../../core/file-mutation.js";
import {
  isSafePathSegment,
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";
import type {
  FileSourceManifest,
  FileSourceManifestFile,
  FileSourceDeleteResult,
  FileSourceRecord,
  FileSourceSaveResult,
  FileSourceSnapshot,
  FileSourceTargetStatus,
} from "./file-source-types.js";

const FILE_USAGE_FILENAME = ".attachment-usage.json";

interface FileUsageRecord {
  name: string;
  uploadedAt: string;
  usedAt: string;
}

interface FileUsageLedger {
  version: 1;
  files: FileUsageRecord[];
}

export interface FileSourceRepositoryOptions {
  rootDir: string;
  containmentRoot: string;
}

export class FileSourceStreamError extends Error {
  constructor(
    readonly code: 'file_too_large' | 'source_changed' | 'unsafe_source',
    message: string = code,
  ) {
    super(message);
    this.name = 'FileSourceStreamError';
  }
}

export class FileSourceRepository<
  TFile extends FileSourceManifestFile = FileSourceManifestFile,
> {
  private readonly rootDir: string;
  private readonly containmentRoot: string;

  constructor(options: FileSourceRepositoryOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.containmentRoot = path.resolve(options.containmentRoot);
  }

  async save(
    filename: string,
    contents: Uint8Array,
    options: { overwrite: boolean },
  ): Promise<FileSourceSaveResult> {
    const target = await this.prepareSaveTarget(filename);
    if (target.status === "invalid_path") return { status: "invalid_path" };
    if (target.status === "duplicate_file" && !options.overwrite) {
      return { status: "duplicate_file" };
    }

    await writeFileAtomic(target.path, contents);
    const stat = await fs.stat(target.path);
    return {
      status: "saved",
      file: {
        name: filename,
        size: stat.size,
        uploadedAt: new Date().toISOString(),
        parseStatus: "pending",
      },
    };
  }

  async saveFromFile(
    sourcePath: string,
    filename: string,
    options: {
      overwrite: boolean;
      maxBytes: number;
      expectedSha256: string;
      signal?: AbortSignal;
    },
  ): Promise<FileSourceSaveResult> {
    throwIfSignalAborted(options.signal);
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      !/^[0-9a-f]{64}$/.test(options.expectedSha256)
    ) {
      throw new Error('File source streaming options are invalid');
    }
    const sourceLstat = await fs.lstat(sourcePath).catch(() => null);
    if (!sourceLstat?.isFile() || sourceLstat.isSymbolicLink()) {
      throw new FileSourceStreamError('unsafe_source');
    }
    const canonicalSource = await fs.realpath(sourcePath).catch(() => null);
    if (!canonicalSource) throw new FileSourceStreamError('unsafe_source');
    const target = await this.prepareSaveTarget(filename);
    if (target.status === "invalid_path") return { status: "invalid_path" };
    if (target.status === "duplicate_file" && !options.overwrite) {
      return { status: "duplicate_file" };
    }
    const sourceHandle = await fs.open(canonicalSource, 'r');
    const temporaryPath = path.join(
      path.dirname(target.path),
      `.${path.basename(target.path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryHandle: fs.FileHandle | undefined;
    try {
      const before = await sourceHandle.stat();
      const currentLstat = await fs.lstat(sourcePath).catch(() => null);
      if (
        !before.isFile() ||
        !currentLstat?.isFile() ||
        currentLstat.isSymbolicLink() ||
        currentLstat.dev !== before.dev ||
        currentLstat.ino !== before.ino
      ) {
        throw new FileSourceStreamError('unsafe_source');
      }
      if (before.size > options.maxBytes) {
        throw new FileSourceStreamError('file_too_large');
      }
      temporaryHandle = await fs.open(temporaryPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let byteLength = 0;
      for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
        throwIfSignalAborted(options.signal);
        const bytes = chunk as Buffer;
        byteLength += bytes.length;
        if (byteLength > options.maxBytes) {
          throw new FileSourceStreamError('file_too_large');
        }
        hash.update(bytes);
        await temporaryHandle.write(bytes);
      }
      const after = await sourceHandle.stat();
      const digest = hash.digest('hex');
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        byteLength !== before.size ||
        digest !== options.expectedSha256
      ) {
        throw new FileSourceStreamError('source_changed');
      }
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      if (options.overwrite) {
        await fs.rename(temporaryPath, target.path);
      } else {
        try {
          await fs.link(temporaryPath, target.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return { status: 'duplicate_file' };
          }
          throw error;
        } finally {
          await fs.rm(temporaryPath, { force: true });
        }
      }
      const stat = await fs.stat(target.path);
      return {
        status: 'saved',
        file: {
          name: filename,
          size: stat.size,
          uploadedAt: new Date().toISOString(),
          parseStatus: 'pending',
        },
      };
    } finally {
      await sourceHandle.close().catch(() => undefined);
      await temporaryHandle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async inspectSaveTarget(filename: string): Promise<FileSourceTargetStatus> {
    return (await this.prepareSaveTarget(filename)).status;
  }

  async list(): Promise<FileSourceRecord[]> {
    return (await this.readSnapshot()).files;
  }

  async readSnapshot(): Promise<FileSourceSnapshot<TFile>> {
    if (existsSync(this.rootDir) && !this.resolveContainedRoot()) {
      return { files: [], manifest: null };
    }

    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { files: [], manifest: null };
      }
      throw error;
    }

    const [manifest, usage] = await Promise.all([
      this.readManifest(),
      this.readUsageLedger(),
    ]);
    const files: FileSourceRecord[] = [];
    for (const name of entries) {
      if (name === "parsed") continue;
      const sourcePath = path.join(this.rootDir, name);
      const stat = await fs.lstat(sourcePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;

      const manifestEntry = manifest?.files.find(
        (file) => file.source === name,
      );
      files.push({
        name,
        size: stat.size,
        uploadedAt: stat.mtime.toISOString(),
        ...whenDefined(usage.files.find(
          (entry) =>
            entry.name === name &&
            entry.uploadedAt === stat.mtime.toISOString(),
        )?.usedAt, (definedValue) => ({ usedAt: definedValue })),
        parseStatus: manifestEntry
          ? manifestEntry.status === "error"
            ? "error"
            : "parsed"
          : "pending",
        ...whenDefined(manifestEntry?.status === "success"
            ? manifest?.generated_at
            : undefined, (definedValue) => ({ parsedAt: definedValue })),
        ...whenDefined(manifestEntry?.status === "error"
            ? manifestEntry.error
            : undefined, (definedValue) => ({ parserError: definedValue })),
        ...whenDefined(manifestEntry?.outputs, (definedValue) => ({ outputs: definedValue })),
      });
    }
    files.sort((left, right) => left.name.localeCompare(right.name));
    return { files, manifest };
  }

  async markCurrentFilesUsed(
    usedAt = new Date().toISOString(),
  ): Promise<FileSourceRecord[]> {
    const snapshot = await this.readSnapshot();
    if (snapshot.files.length === 0) return [];

    const currentUsage = await this.readUsageLedger();
    const nextUsage: FileUsageLedger = {
      version: 1,
      files: snapshot.files.map((file) => {
        const existing = currentUsage.files.find(
          (entry) =>
            entry.name === file.name && entry.uploadedAt === file.uploadedAt,
        );
        return existing ?? {
          name: file.name,
          uploadedAt: file.uploadedAt,
          usedAt,
        };
      }),
    };
    await this.writeUsageLedger(nextUsage);
    return snapshot.files.map((file) => ({
      ...file,
      usedAt:
        nextUsage.files.find(
          (entry) =>
            entry.name === file.name && entry.uploadedAt === file.uploadedAt,
        )?.usedAt ?? usedAt,
    }));
  }

  async deleteIfUnused(filename: string): Promise<FileSourceDeleteResult> {
    const current = (await this.readSnapshot()).files.find(
      (file) => file.name === filename,
    );
    if (!current) return "not_found";
    if (current.usedAt) return "locked";
    return (await this.delete(filename)) ? "deleted" : "not_found";
  }

  async delete(filename: string): Promise<boolean> {
    if (!isSafePathSegment(filename)) return false;
    if (!this.resolveContainedRoot()) return false;
    const targetPath = resolveRelativePathInside(this.rootDir, filename);
    if (!targetPath) return false;
    if (
      existsSync(targetPath) &&
      !resolveExistingPathInside(this.rootDir, targetPath)
    ) {
      return false;
    }

    try {
      await fs.unlink(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    await this.removeUsageRecord(filename);

    const parsedDir = this.resolveParsedDir();
    const manifest = parsedDir ? await this.readManifest() : null;
    if (!manifest || !parsedDir) return true;
    const entryIndex = manifest.files.findIndex(
      (file) => file.source === filename,
    );
    if (entryIndex === -1) return true;

    const [entry] = manifest.files.splice(entryIndex, 1);
    for (const outputName of Object.values(entry?.outputs ?? {})) {
      const outputPath = resolveRelativePathInside(parsedDir, outputName);
      if (
        !outputPath ||
        !existsSync(outputPath) ||
        !resolveExistingPathInside(parsedDir, outputPath)
      ) {
        continue;
      }
      await fs.unlink(outputPath).catch(() => undefined);
    }
    await this.writeManifest(manifest);
    return true;
  }

  async readParsedText(outputName: string): Promise<string | null> {
    if (!isSafePathSegment(outputName)) return null;
    const parsedDir = this.resolveParsedDir();
    if (!parsedDir) return null;
    const outputPath = resolveRelativePathInside(parsedDir, outputName);
    if (!outputPath || !resolveExistingPathInside(parsedDir, outputPath)) {
      return null;
    }
    const stat = await fs.lstat(outputPath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) return null;
    return fs.readFile(outputPath, "utf8");
  }

  async readSafeTextSource(
    filename: string,
    allowedExtensions: ReadonlySet<string>,
  ): Promise<string | null> {
    if (
      !isSafePathSegment(filename) ||
      !allowedExtensions.has(path.extname(filename).toLowerCase()) ||
      !this.resolveContainedRoot()
    ) {
      return null;
    }
    const sourcePath = resolveRelativePathInside(this.rootDir, filename);
    if (!sourcePath || !resolveExistingPathInside(this.rootDir, sourcePath)) {
      return null;
    }
    const stat = await fs.lstat(sourcePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) return null;
    return fs.readFile(sourcePath, "utf8");
  }

  async readManifest(): Promise<FileSourceManifest<TFile> | null> {
    const parsedDir = this.resolveParsedDir();
    if (!parsedDir) return null;
    const manifestPath = path.join(parsedDir, "_manifest.json");
    if (
      existsSync(manifestPath) &&
      !resolveExistingPathInside(parsedDir, manifestPath)
    ) {
      return null;
    }
    try {
      return parseManifest<TFile>(
        JSON.parse(await fs.readFile(manifestPath, "utf8")),
      );
    } catch {
      return null;
    }
  }

  async writeManifest(manifest: FileSourceManifest<TFile>): Promise<void> {
    const parsedDir = this.resolveParsedDir();
    if (!parsedDir) {
      throw new Error("Parsed document directory is unavailable");
    }
    await writeFileAtomic(
      path.join(parsedDir, "_manifest.json"),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    );
  }

  private resolveContainedRoot(): string | null {
    return resolveExistingPathInside(this.containmentRoot, this.rootDir);
  }

  private resolveParsedDir(): string | null {
    if (!this.resolveContainedRoot()) return null;
    const parsedDir = path.join(this.rootDir, "parsed");
    return resolveExistingPathInside(this.rootDir, parsedDir);
  }

  private usagePath(): string {
    const usagePath = resolveRelativePathInside(
      this.containmentRoot,
      FILE_USAGE_FILENAME,
    );
    if (!usagePath) throw new Error("Attachment usage path is invalid");
    return usagePath;
  }

  private async readUsageLedger(): Promise<FileUsageLedger> {
    const usagePath = this.usagePath();
    const stat = await fs.lstat(usagePath).catch(() => null);
    if (!stat) return { version: 1, files: [] };
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !resolveExistingPathInside(this.containmentRoot, usagePath)
    ) {
      throw new Error("Attachment usage ledger is invalid");
    }
    try {
      const value: unknown = JSON.parse(await fs.readFile(usagePath, "utf8"));
      if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.files)) {
        throw new Error("Attachment usage ledger is invalid");
      }
      const files = value.files.filter(isFileUsageRecord);
      if (files.length !== value.files.length) {
        throw new Error("Attachment usage ledger is invalid");
      }
      return { version: 1, files };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Attachment usage ledger is invalid"
      ) {
        throw error;
      }
      throw new Error("Attachment usage ledger is invalid", { cause: error });
    }
  }

  private async writeUsageLedger(ledger: FileUsageLedger): Promise<void> {
    await writeFileAtomic(
      this.usagePath(),
      Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, "utf8"),
    );
  }

  private async removeUsageRecord(filename: string): Promise<void> {
    const current = await this.readUsageLedger();
    const files = current.files.filter((entry) => entry.name !== filename);
    if (files.length === current.files.length) return;
    await this.writeUsageLedger({ version: 1, files });
  }

  private async prepareSaveTarget(
    filename: string,
  ): Promise<
    | { status: "available"; path: string }
    | { status: "duplicate_file"; path: string }
    | { status: "invalid_path" }
  > {
    if (!isSafePathSegment(filename)) return { status: "invalid_path" };
    try {
      await fs.mkdir(this.rootDir, { recursive: true });
    } catch {
      return { status: "invalid_path" };
    }
    if (!this.resolveContainedRoot()) return { status: "invalid_path" };

    const targetPath = resolveRelativePathInside(this.rootDir, filename);
    if (!targetPath) return { status: "invalid_path" };
    const existing = await fs.lstat(targetPath).catch(() => null);
    if (existing?.isSymbolicLink()) return { status: "invalid_path" };
    if (
      existing &&
      !resolveExistingPathInside(this.rootDir, targetPath)
    ) {
      return { status: "invalid_path" };
    }
    return existing
      ? { status: "duplicate_file", path: targetPath }
      : { status: "available", path: targetPath };
  }
}

function parseManifest<TFile extends FileSourceManifestFile>(
  value: unknown,
): FileSourceManifest<TFile> | null {
  if (!isRecord(value) || !Array.isArray(value.files)) return null;
  const files: TFile[] = [];
  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      typeof entry.source !== "string" ||
      (entry.status !== "success" && entry.status !== "error")
    ) {
      return null;
    }
    const outputs = parseOutputs(entry.outputs);
    if (entry.outputs !== undefined && !outputs) return null;
    files.push({
      ...entry,
      ...(outputs ? { outputs } : {}),
    } as TFile);
  }
  const manifest = {
    ...value,
    files,
  } as FileSourceManifest<TFile>;
  if (typeof value.generated_at !== "string") {
    delete manifest.generated_at;
  }
  return manifest;
}

function parseOutputs(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, output]) => typeof output === "string")) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFileUsageRecord(value: unknown): value is FileUsageRecord {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.uploadedAt === "string" &&
    Number.isFinite(Date.parse(value.uploadedAt)) &&
    typeof value.usedAt === "string" &&
    Number.isFinite(Date.parse(value.usedAt))
  );
}
