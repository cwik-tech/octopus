import {
  deriveTitleFromBrief,
  isGenericRequestTitle,
  looksLikeNarration,
} from '../job-title/job-title-sanitize.js'
import { generateConciseTitle } from '../sessions/session-title.js'
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'

const DEFAULT_TITLE_TIMEOUT_MS = 3_000
const MAX_FILENAME_BASE_LENGTH = 64
const GENERIC_FILENAME_BASES = new Set(['result', 'untitled', 'untitled-session'])
const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export interface ScheduledArtifactFilenameInput {
  brief: string
  firedAt: Date
  titleTimeoutMs?: number
  /** See `ConciseTitleInput.onSelected`. */
  onSelected?: (selection: ModelSelectionRecord) => Promise<boolean>
}

/**
 * Generate a semantic Markdown filename without making schedule admission
 * depend on the title provider. Provider failures and timeouts retain the same
 * deterministic brief fallback used by chat titles.
 */
export async function generateScheduledArtifactFilename(
  input: ScheduledArtifactFilenameInput,
): Promise<string> {
  const controller = new AbortController()
  const timeoutMs = input.titleTimeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const result = await generateConciseTitle({
      history: [{ role: 'user', text: input.brief }],
      signal: controller.signal,
      // Recorded before anything is sent. An owner that cannot record it
      // declines and nothing is dispatched — the deterministic name below is
      // then what the schedule uses, which is what it has always fallen back
      // to. No second name is invented for this case.
      ...(input.onSelected ? { onSelected: input.onSelected } : {}),
    })
    const generatedTitle = usableTitle(result.title)
    const deterministicTitle = usableTitle(deriveTitleFromBrief(input.brief))
    return buildScheduledArtifactFilename(
      generatedTitle ?? deterministicTitle,
      input.firedAt,
    )
  } catch {
    return buildScheduledArtifactFilename(
      usableTitle(deriveTitleFromBrief(input.brief)),
      input.firedAt,
    )
  } finally {
    clearTimeout(timeout)
  }
}

export function buildScheduledArtifactFilename(
  title: string | null | undefined,
  firedAt: Date,
): string {
  const slug = title ? filenameSlug(title) : ''
  if (!slug || GENERIC_FILENAME_BASES.has(slug) || WINDOWS_RESERVED_FILENAME.test(slug)) {
    return timestampedResultFilename(firedAt)
  }
  return `${slug}.md`
}

export function timestampedResultFilename(firedAt: Date): string {
  const timestamp = firedAt
    .toISOString()
    .slice(0, 19)
    .replace('T', '-')
    .replaceAll(':', '-')
  return `result-${timestamp}Z.md`
}

function usableTitle(title: string | null): string | null {
  if (!title || looksLikeNarration(title) || isGenericRequestTitle(title)) {
    return null
  }
  return title.trim() || null
}

function filenameSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FILENAME_BASE_LENGTH)
    .replace(/-+$/g, '')
}
