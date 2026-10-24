/**
 * Shared plumbing for internally generated run targets — the thin wrappers the
 * app materializes so a scheduled agent or a chat-selected team can be launched
 * through the ordinary workflow path.
 *
 * Extracted from `scheduled-agent-target.ts` when `team-chat-target.ts` needed
 * the same registry-block editing and idempotency primitives.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { withFileMutationLock, writeFileAtomic } from '../core/file-mutation.js'
import { SCHEDULER_GENERATED_TAG } from '../domains/scheduling/schedule-types.js'

/** Marks a wrapper materialized for a chat-selected team. */
export const CHAT_GENERATED_TAG = 'chat-generated' as const

/**
 * Tags that mark a workflow as an internal wrapper rather than something a
 * person picked from the catalog. Catalog listings hide these by default.
 */
export const GENERATED_TARGET_TAGS: readonly string[] = [
  SCHEDULER_GENERATED_TAG,
  CHAT_GENERATED_TAG,
]

export function isGeneratedTarget(tags: readonly string[] | undefined): boolean {
  return (tags ?? []).some((tag) => GENERATED_TARGET_TAGS.includes(tag))
}

export async function readTextIfExists(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  }
}

export function relativeYamlPath(
  fromDirectory: string,
  targetPath: string,
): string {
  const relative = path.relative(fromDirectory, targetPath).split(path.sep).join('/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

export function yamlQuoted(value: string): string {
  return JSON.stringify(value)
}

/**
 * Reduce a name to something safe to embed in a wrapper identifier. Returns
 * undefined when nothing usable is left, so callers can raise their own
 * domain-specific error.
 */
export function sanitizeWrapperSegment(name: string): string | undefined {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return safe || undefined
}

export async function upsertRegistryBlock(params: {
  registryPath: string
  key: string
  block: string
}): Promise<void> {
  await withFileMutationLock(params.registryPath, async () => {
    const existing = await readTextIfExists(params.registryPath) ?? ''
    const next = replaceTopLevelBlock(existing, params.key, params.block)
    if (next === existing) return
    await fs.mkdir(path.dirname(params.registryPath), { recursive: true })
    await writeFileAtomic(params.registryPath, next)
  })
}

export function replaceTopLevelBlock(
  text: string,
  key: string,
  block: string,
): string {
  const lines = text.split('\n')
  const range = topLevelBlockRange(lines, key)
  const normalizedBlock = block.trimEnd().split('\n')
  if (range) {
    const next = [
      ...lines.slice(0, range.start),
      ...normalizedBlock,
      ...lines.slice(range.end),
    ].join('\n')
    return `${next.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
  }
  const prefix = text.trimEnd()
  return `${prefix}${prefix ? '\n\n' : ''}${normalizedBlock.join('\n')}\n`
}

export function extractTopLevelBlock(text: string, key: string): string {
  const lines = text.split('\n')
  const range = topLevelBlockRange(lines, key)
  return range ? lines.slice(range.start, range.end).join('\n') : ''
}

function topLevelBlockRange(
  lines: readonly string[],
  key: string,
): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line === `${key}:`)
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line === undefined) break
    if (/^[^\s#][^:]*:/.test(line)) break
    end += 1
  }
  while (end > start + 1 && lines[end - 1]?.trim() === '') end -= 1
  return { start, end }
}
