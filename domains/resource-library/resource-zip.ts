import JSZip from 'jszip';
import { Entry, fromBufferPromise } from 'yauzl';
import * as z from 'zod/v4';
import { crc32 } from 'node:zlib';
import { normalizeResourcePath, type ResourceSkillFile, type ResourceSkillFiles } from './skill-files.js';

const zipEntryHeaderSchema = z.object({ fileName: z.string(), fileNameRaw: z.instanceof(Buffer), relativeOffsetOfLocalHeader: z.number().int().nonnegative().safe(), compressedSize: z.number().int().nonnegative().safe(), uncompressedSize: z.number().int().nonnegative().safe(), externalFileAttributes: z.number().int().min(0).max(0xffffffff), crc32: z.number().int().min(0).max(0xffffffff), generalPurposeBitFlag: z.number().int().nonnegative(), compressionMethod: z.number().int().nonnegative() });
function isZipEntry(value: unknown): value is Entry { return value instanceof Entry && zipEntryHeaderSchema.safeParse(value).success; }

export interface ResourceZipLimits {
  maxCompressedBytes: number; maxEntries: number; maxFileBytes: number; maxExpandedBytes: number; maxDepth: number;
}
export const RESOURCE_ZIP_LIMITS: Readonly<ResourceZipLimits> = {
  maxCompressedBytes: 64 * 1024 * 1024, maxEntries: 1000,
  maxFileBytes: 16 * 1024 * 1024, maxExpandedBytes: 128 * 1024 * 1024, maxDepth: 12,
};

export async function readResourceZip(bytes: Buffer, options: {
  signal?: AbortSignal; limits?: Partial<ResourceZipLimits>;
} = {}): Promise<ResourceSkillFiles> {
  options.signal?.throwIfAborted();
  const limits = { ...RESOURCE_ZIP_LIMITS, ...options.limits };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid ZIP limits');
  if (bytes.length > limits.maxCompressedBytes) throw new Error('Compressed ZIP limit exceeded');
  const zip = await fromBufferPromise(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false });
  const files = new Map<string, ResourceSkillFile>();
  const entries = new Set<string>();
  const spellings = new Map<string, string>();
  const kinds = new Map<string, 'file' | 'directory'>();
  let expanded = 0;
  try {
    if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount < 0) throw new Error('Invalid ZIP entry count');
    if (zip.entryCount > limits.maxEntries) throw new Error('ZIP entry count limit exceeded');
    for await (const candidate of zip.eachEntry()) {
      const entry: unknown = candidate;
      if (!isZipEntry(entry)) throw new Error('Invalid ZIP entry metadata');
      if ((entry.generalPurposeBitFlag & 0x800) !== 0) new TextDecoder('utf-8', { fatal: true }).decode(entry.fileNameRaw);
      options.signal?.throwIfAborted();
      const directory = entry.fileName.endsWith('/');
      const name = normalizeResourcePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const segments = name.split('/');
      if (segments.length > limits.maxDepth) throw new Error('ZIP depth limit exceeded');
      if (segments.some((part) => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`Invalid portable path: ${name}`);
      const canonical = name.normalize('NFC').toLowerCase();
      if (entries.has(canonical)) throw new Error(`Duplicate ZIP entry or path collision: ${name}`);
      entries.add(canonical);
      for (let index = 1; index <= segments.length; index += 1) {
        const prefix = segments.slice(0, index).join('/');
        const key = prefix.normalize('NFC').toLowerCase();
        const previous = spellings.get(key);
        if (previous !== undefined && previous !== prefix) throw new Error(`ZIP path collision: ${prefix}`);
        spellings.set(key, prefix);
        const kind = index === segments.length && !directory ? 'file' : 'directory';
        if (kinds.has(key) && kinds.get(key) !== kind) throw new Error(`ZIP file/directory collision: ${prefix}`);
        kinds.set(key, kind);
      }
      const mode = entry.externalFileAttributes >>> 16;
      const type = mode & 0o170000;
      if (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) throw new Error(`Unsupported ZIP file type: ${name}`);
      if (entry.isEncrypted() || !entry.canDecodeFileData()) throw new Error(`Unsupported ZIP encoding: ${name}`);
      if (directory) continue;
      if (entry.uncompressedSize > limits.maxFileBytes) throw new Error(`ZIP file size limit exceeded: ${name}`);
      if (expanded + entry.uncompressedSize > limits.maxExpandedBytes) throw new Error('ZIP expanded size limit exceeded');
      const stream = await zip.openReadStreamPromise(entry);
      const abort = () => stream.destroy(new Error('ZIP read aborted'));
      options.signal?.addEventListener('abort', abort, { once: true });
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const value of stream) {
          options.signal?.throwIfAborted();
          const chunk: unknown = value;
          if (!Buffer.isBuffer(chunk)) throw new Error('ZIP stream returned non-binary data');
          size += chunk.length; expanded += chunk.length;
          if (size > limits.maxFileBytes) throw new Error(`ZIP file size limit exceeded: ${name}`);
          if (expanded > limits.maxExpandedBytes) throw new Error('ZIP expanded size limit exceeded');
          chunks.push(chunk);
        }
      } finally { options.signal?.removeEventListener('abort', abort); stream.destroy(); }
      const contents = Buffer.concat(chunks);
      if (size !== entry.uncompressedSize || crc32(contents) !== entry.crc32) throw new Error(`ZIP checksum or size mismatch: ${name}`);
      const executable = (mode & 0o111) !== 0;
      files.set(name, { contents, mode: executable ? 0o755 : 0o644, executable });
    }
    options.signal?.throwIfAborted();
    return files;
  } finally { zip.close(); }
}

export async function writeResourceZip(files: ResourceSkillFiles, options: { signal?: AbortSignal } = {}): Promise<Buffer> {
  options.signal?.throwIfAborted();
  const zip = new JSZip();
  for (const [name, file] of files) {
    options.signal?.throwIfAborted();
    zip.file(normalizeResourcePath(name), file.contents, { createFolders: false, unixPermissions: file.executable ? 0o100755 : 0o100644, date: new Date('1980-01-01T00:00:00.000Z') });
  }
  const output: unknown = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' }, () => options.signal?.throwIfAborted());
  if (!Buffer.isBuffer(output)) throw new Error('ZIP writer returned non-binary data');
  const bytes = output;
  // Apply the same portable path and size policy before offering a completed export.
  await readResourceZip(bytes, options);
  return bytes;
}
