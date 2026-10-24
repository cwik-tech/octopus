import * as fs from 'node:fs'

interface JsonlCacheEntry<T> {
  mtimeMs: number
  size: number
  values: T[]
}

export class JsonlFileCache {
  private readonly cache = new Map<string, JsonlCacheEntry<unknown>>()

  read<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) return []

    const stat = fs.statSync(filePath)
    const cached = this.cache.get(filePath) as JsonlCacheEntry<T> | undefined
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.values
    }

    const values = readJsonlFile<T>(filePath)
    this.cache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      values,
    })
    return values
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }
}

export function readJsonlFile<T>(filePath: string): T[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim()
  if (!raw) return []

  const values: T[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      values.push(JSON.parse(line) as T)
    } catch {
      continue
    }
  }
  return values
}
