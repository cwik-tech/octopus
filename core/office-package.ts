import { JSDOM } from 'jsdom'
import { crc32, inflateRawSync } from 'node:zlib'
import { OFFICE_ARCHIVE_MAX_ENTRIES, OFFICE_ARCHIVE_MAX_RATIO, OFFICE_CONTENT_TYPES_PART, OFFICE_EXPANDED_MAX_BYTES, OFFICE_INPUT_MAX_BYTES, OFFICE_PACKAGE_PARTS, OFFICE_PACKAGE_TYPES, OFFICE_ZIP, type OfficeFailure, type OfficeFormat } from '../contracts/office-documents.js'

export type OfficePackageResult = { readonly ok: true; readonly entries: ReadonlyMap<string, Buffer> } | OfficeFailure

/** Strict, bounded ZIP subset: stored/deflated entries; no ZIP64 or encryption. */
export function inspectOfficePackage(bytes: Buffer, format: OfficeFormat): OfficePackageResult {
  try {
    if (bytes.length > OFFICE_INPUT_MAX_BYTES) return unsafe()
    const end = endRecord(bytes)
    if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) return unsafe()
    const count = bytes.readUInt16LE(end + 10)
    if (count === 0 || count > OFFICE_ARCHIVE_MAX_ENTRIES || bytes.readUInt16LE(end + 8) !== count) return unsafe()
    const centralSize = bytes.readUInt32LE(end + 12)
    let cursor = bytes.readUInt32LE(end + 16)
    if (cursor + centralSize !== end) return unsafe()
    const entries = new Map<string, Buffer>()
    const names = new Set<string>()
    const ranges: { start: number; end: number }[] = []
    let expanded = 0
    for (let index = 0; index < count; index += 1) {
      if (cursor + OFFICE_ZIP.centralBytes > end || bytes.readUInt32LE(cursor) !== OFFICE_ZIP.central) return unsafe()
      const flags = bytes.readUInt16LE(cursor + 8)
      const method = bytes.readUInt16LE(cursor + 10)
      const crc = bytes.readUInt32LE(cursor + 16)
      const compressed = bytes.readUInt32LE(cursor + 20)
      const size = bytes.readUInt32LE(cursor + 24)
      const nameSize = bytes.readUInt16LE(cursor + 28)
      const nameEnd = cursor + OFFICE_ZIP.centralBytes + nameSize
      const next = nameEnd + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32)
      const local = bytes.readUInt32LE(cursor + 42)
      if (next > end || (flags & ~0x808) !== 0 || (method !== 0 && method !== 8) || bytes.readUInt16LE(cursor + 34) !== 0 || local === OFFICE_ZIP.zip64Size) return unsafe()
      const nameBytes = bytes.subarray(cursor + OFFICE_ZIP.centralBytes, nameEnd)
      const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
      const segments = name.replace(/\/$/, '').split('/')
      if (!name || /[\\\x00-\x1f:]/.test(name) || segments.some((part) => !part || part === '.' || part === '..') || names.has(name.toLowerCase()) || /vbaProject|\.bin$|activeX\//i.test(name)) return unsafe()
      if (((bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000) return unsafe()
      names.add(name.toLowerCase())
      if (size > OFFICE_EXPANDED_MAX_BYTES - expanded || size > Math.max(compressed, 1) * OFFICE_ARCHIVE_MAX_RATIO) return unsafe()
      if (local + OFFICE_ZIP.localBytes > bytes.readUInt32LE(end + 16) || bytes.readUInt32LE(local) !== OFFICE_ZIP.local || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) return unsafe()
      const localNameEnd = local + OFFICE_ZIP.localBytes + bytes.readUInt16LE(local + 26)
      const start = localNameEnd + bytes.readUInt16LE(local + 28)
      const finish = start + compressed
      if (!bytes.subarray(local + OFFICE_ZIP.localBytes, localNameEnd).equals(nameBytes) || finish > bytes.readUInt32LE(end + 16) || ranges.some((range) => local < range.end && finish > range.start)) return unsafe()
      ranges.push({ start: local, end: finish })
      const source = bytes.subarray(start, finish)
      const output = method === 0 ? source : inflateRawSync(source, { maxOutputLength: Math.max(1, Math.min(size, OFFICE_EXPANDED_MAX_BYTES - expanded)) })
      if (output.length !== size || crc32(output) !== crc) return unsafe()
      expanded += output.length
      if (!name.endsWith('/')) entries.set(name, output)
      cursor = next
    }
    const contentTypes = entries.get(OFFICE_CONTENT_TYPES_PART)?.toString('utf8')
    if (cursor !== end || !entries.has(OFFICE_PACKAGE_PARTS[format]) || !contentTypes?.includes(OFFICE_PACKAGE_TYPES[format]) || /macroEnabled|vbaProject/i.test(contentTypes)) return unsafe()
    for (const [name, data] of entries) {
      if (!/\.(xml|rels)$/i.test(name)) continue
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(data)
      if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml) || xml.includes('\0')) return unsafe()
      if (!name.endsWith('.rels')) continue
      const dom = new JSDOM(xml, { contentType: 'application/xml' })
      try {
        for (const relationship of dom.window.document.getElementsByTagNameNS('*', 'Relationship')) {
          if (relationship.getAttribute('TargetMode') !== 'External') continue
          const type = relationship.getAttribute('Type') ?? ''
          const target = relationship.getAttribute('Target') ?? ''
          if (!type.endsWith('/hyperlink') || !/^(https?:|mailto:)/i.test(target)) return unsafe()
        }
      } finally { dom.window.close() }
    }
    return { ok: true, entries }
  } catch { return unsafe() }
}

function endRecord(bytes: Buffer): number {
  const lower = Math.max(0, bytes.length - OFFICE_ZIP.endBytes - OFFICE_ZIP.commentMax)
  for (let cursor = bytes.length - OFFICE_ZIP.endBytes; cursor >= lower; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === OFFICE_ZIP.end && cursor + OFFICE_ZIP.endBytes + bytes.readUInt16LE(cursor + 20) === bytes.length) return cursor
  }
  return -1
}
const unsafe = (): OfficeFailure => ({ ok: false, code: 'unsafe_package' })
