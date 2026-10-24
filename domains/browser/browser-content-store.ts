import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import type {
  BrowserContentMatchView,
  BrowserContentView,
} from './browser-types.js'

const CHUNK_BYTES = 24 * 1_024
const MAX_CONTENT_BYTES = 10 * 1_024 * 1_024
const MAX_MATCHES = 20
const MAX_SNIPPET_CHARS = 400

interface ContentRecord {
  readonly id: string
  readonly assignmentKey: string
  readonly assignmentPath: string
  readonly chunks: readonly string[]
  readonly sizeBytes: number
}

export class BrowserContentStore {
  private readonly records = new Map<string, ContentRecord>()

  async write(params: {
    readonly assignmentKey: string
    readonly assignmentPath: string
    readonly text: string
  }): Promise<BrowserContentView> {
    const normalized = params.text.replace(/\r\n?/g, '\n').trim()
    const bytes = Buffer.byteLength(normalized, 'utf8')
    if (bytes > MAX_CONTENT_BYTES) {
      throw new Error('Browser content exceeded the 10 MB extraction limit.')
    }
    const id = `browser-content-${randomUUID()}`
    const chunks = chunkUtf8(normalized, CHUNK_BYTES)
    const directory = path.join(params.assignmentPath, 'browser-content')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, `${id}.txt`), normalized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    const record: ContentRecord = {
      id,
      assignmentKey: params.assignmentKey,
      assignmentPath: params.assignmentPath,
      chunks,
      sizeBytes: bytes,
    }
    this.records.set(id, record)
    return view(record)
  }

  read(assignmentKey: string, id: string, chunkIndex = 0): BrowserContentView | null {
    const record = this.records.get(id)
    if (!record || record.assignmentKey !== assignmentKey) return null
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= record.chunks.length) {
      return null
    }
    return view(record, chunkIndex)
  }

  search(assignmentKey: string, id: string, query: string): readonly BrowserContentMatchView[] | null {
    const record = this.records.get(id)
    if (!record || record.assignmentKey !== assignmentKey) return null
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const matches: BrowserContentMatchView[] = []
    for (const [chunkIndex, chunk] of record.chunks.entries()) {
      const lower = chunk.toLocaleLowerCase()
      let offset = lower.indexOf(needle)
      while (offset >= 0 && matches.length < MAX_MATCHES) {
        const start = Math.max(0, offset - Math.floor(MAX_SNIPPET_CHARS / 2))
        const end = Math.min(chunk.length, offset + needle.length + Math.floor(MAX_SNIPPET_CHARS / 2))
        matches.push({
          chunkIndex,
          snippet: `${start > 0 ? '…' : ''}${chunk.slice(start, end).replace(/\s+/g, ' ').trim()}${end < chunk.length ? '…' : ''}`,
        })
        offset = lower.indexOf(needle, offset + Math.max(needle.length, 1))
      }
      if (matches.length >= MAX_MATCHES) break
    }
    return matches
  }

  releaseAssignment(assignmentKey: string): void {
    for (const [id, record] of this.records) {
      if (record.assignmentKey === assignmentKey) this.records.delete(id)
    }
  }

  clear(): void {
    this.records.clear()
  }
}

function view(record: ContentRecord, currentChunk?: number): BrowserContentView {
  return {
    id: record.id,
    sizeBytes: record.sizeBytes,
    chunkCount: record.chunks.length,
    ...(currentChunk !== undefined
      ? { currentChunk, text: record.chunks[currentChunk] ?? '' }
      : {}),
  }
}

function chunkUtf8(value: string, maxBytes: number): string[] {
  if (!value) return ['']
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (current && currentBytes + size > maxBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += size
  }
  if (current || chunks.length === 0) chunks.push(current)
  return chunks
}
