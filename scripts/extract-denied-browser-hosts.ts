/**
 * Turn persisted research activities into the tracked denied-host cohort.
 *
 * The cohort is the only list the opt-in local browser measurement is allowed to
 * touch, so everything here is written for a file that may be anything at all:
 * parsing, validation, redaction and aggregation are separate, and the
 * filesystem is reached only by the command at the bottom.
 *
 * Nothing session-identifying leaves this file. Session and run identifiers,
 * assignment identifiers, queries, fragments, page text and error messages are
 * read to produce counts and are never written to the cohort.
 *
 * Usage:
 *   tsx scripts/extract-denied-browser-hosts.ts \
 *     --sessions <sessions-directory> --out <cohort.json>
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DENIED_HOST_COHORT_SCHEMA_VERSION = 1 as const

/** The three attempt outcomes that mean a host refused a read. */
const DENIED_OUTCOMES = ['access-denied', 'challenge', 'rate-limited'] as const

type DeniedOutcome = (typeof DENIED_OUTCOMES)[number]

export interface DeniedHostEntry {
  readonly host: string
  /** A public HTTPS URL with no userinfo, query, or fragment. */
  readonly probeUrl: string
  readonly deniedAttempts: number
  readonly accessDenied: number
  readonly challenge: number
  readonly rateLimited: number
  /** Distinct sessions in which this host had at least one denied attempt. */
  readonly sessions: number
  readonly firstObservedAt: string
  readonly lastObservedAt: string
}

export interface DeniedHostCohort {
  readonly schemaVersion: typeof DENIED_HOST_COHORT_SCHEMA_VERSION
  readonly hosts: readonly DeniedHostEntry[]
}

/**
 * What the scan refused, so a shrinking cohort cannot be mistaken for a quiet
 * one. Counts only: a rejected URL is never reported back.
 */
export interface DeniedHostRejections {
  readonly unreadableFiles: number
  /**
   * Records that carry no acquisition URL at all.
   *
   * A `search` activity is the ordinary case and vastly outnumbers everything
   * else, so it is counted apart from a malformed record. Folding the two
   * together made a healthy scan report hundreds of malformed rows.
   */
  readonly recordsWithoutSourceUrl: number
  readonly malformedRecords: number
  readonly credentialBearingUrls: number
  readonly nonPublicUrls: number
  readonly nonHttpsUrls: number
}

export interface DeniedHostCohortResult {
  readonly cohort: DeniedHostCohort
  readonly rejected: DeniedHostRejections
}

/**
 * The two persisted journals a denial can be recorded in.
 *
 * `research-acquisition` stores an attempts array per activity;
 * `browser-activity` stores one flat `url` plus a typed `error.code`. They are
 * different schemas for the same fact, and a cohort built from either alone is
 * a slice of the history rather than the history.
 */
export type PersistedJournalKind = 'research-acquisition' | 'browser-activity'

export interface PersistedActivityFile {
  readonly sessionId: string
  readonly kind: PersistedJournalKind
  /** Whatever `JSON.parse` produced. Treated as unknown. */
  readonly contents: unknown
}

interface HostAccumulator {
  accessDenied: number
  challenge: number
  rateLimited: number
  readonly sessions: Set<string>
  readonly probeCandidates: Set<string>
  firstObservedAt: string
  lastObservedAt: string
}

export function buildDeniedHostCohort(
  files: readonly PersistedActivityFile[],
): DeniedHostCohortResult {
  const hosts = new Map<string, HostAccumulator>()
  let unreadableFiles = 0
  let recordsWithoutSourceUrl = 0
  let malformedRecords = 0
  let credentialBearingUrls = 0
  let nonPublicUrls = 0
  let nonHttpsUrls = 0

  for (const file of files) {
    if (!Array.isArray(file.contents)) {
      unreadableFiles += 1
      continue
    }
    for (const record of file.contents) {
      const activity = file.kind === 'browser-activity'
        ? readBrowserActivity(record)
        : readActivity(record)
      if (activity === 'ignored') continue
      if (activity === 'no-source-url') {
        recordsWithoutSourceUrl += 1
        continue
      }
      if (!activity) {
        malformedRecords += 1
        continue
      }
      const denied = activity.attempts.filter(isDeniedOutcome)
      if (denied.length === 0) continue

      const probe = safeProbeUrl(activity.url)
      if (probe.kind === 'credentialed') {
        credentialBearingUrls += 1
        continue
      }
      if (probe.kind === 'non-public') {
        nonPublicUrls += 1
        continue
      }
      if (probe.kind === 'non-https') {
        nonHttpsUrls += 1
        continue
      }
      if (probe.kind === 'malformed') {
        malformedRecords += 1
        continue
      }

      const entry = hosts.get(probe.host) ?? {
        accessDenied: 0,
        challenge: 0,
        rateLimited: 0,
        sessions: new Set<string>(),
        probeCandidates: new Set<string>(),
        firstObservedAt: '',
        lastObservedAt: '',
      }
      entry.sessions.add(file.sessionId)
      entry.probeCandidates.add(probe.url)
      for (const outcome of denied) {
        if (outcome.outcome === 'access-denied') entry.accessDenied += 1
        else if (outcome.outcome === 'challenge') entry.challenge += 1
        else entry.rateLimited += 1
        const observedAt = outcome.startedAt ?? activity.observedAt
        if (!observedAt) continue
        if (!entry.firstObservedAt || observedAt < entry.firstObservedAt) {
          entry.firstObservedAt = observedAt
        }
        if (!entry.lastObservedAt || observedAt > entry.lastObservedAt) {
          entry.lastObservedAt = observedAt
        }
      }
      hosts.set(probe.host, entry)
    }
  }

  return {
    cohort: {
      schemaVersion: DENIED_HOST_COHORT_SCHEMA_VERSION,
      hosts: [...hosts.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([host, entry]) => ({
          host,
          // Deterministic rather than first-seen, so two scans of the same data
          // produce byte-identical fixtures whatever order the directory listed.
          // A host only exists here because a safe candidate was added for it,
          // so the fallback is unreachable rather than a silent default.
          probeUrl: [...entry.probeCandidates].sort()[0] ?? `https://${host}/`,
          deniedAttempts:
            entry.accessDenied + entry.challenge + entry.rateLimited,
          accessDenied: entry.accessDenied,
          challenge: entry.challenge,
          rateLimited: entry.rateLimited,
          sessions: entry.sessions.size,
          firstObservedAt: entry.firstObservedAt,
          lastObservedAt: entry.lastObservedAt,
        })),
    },
    rejected: {
      unreadableFiles,
      recordsWithoutSourceUrl,
      malformedRecords,
      credentialBearingUrls,
      nonPublicUrls,
      nonHttpsUrls,
    },
  }
}

interface ValidatedActivity {
  readonly url: string
  readonly observedAt?: string
  readonly attempts: readonly { readonly outcome: string; readonly startedAt?: string }[]
}

/**
 * A plain object, established rather than assumed.
 *
 * Everything this file reads comes off disk, so it is narrowed by a guard
 * instead of asserted into a shape it may not have.
 */
type UnknownRecord = Readonly<Record<string, unknown>>

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readActivity(
  value: unknown,
): ValidatedActivity | 'no-source-url' | null {
  if (!isUnknownRecord(value)) return null
  const record = value
  const url =
    typeof record.requestedUrl === 'string'
      ? record.requestedUrl
      : typeof record.canonicalUrl === 'string'
        ? record.canonicalUrl
        : undefined
  if (!url) return 'no-source-url'
  if (!Array.isArray(record.attempts)) return null
  const attempts: { outcome: string; startedAt?: string }[] = []
  for (const attempt of record.attempts) {
    if (!isUnknownRecord(attempt)) continue
    const shape = attempt
    if (typeof shape.outcome !== 'string') continue
    attempts.push({
      outcome: shape.outcome,
      ...(typeof shape.startedAt === 'string' ? { startedAt: shape.startedAt } : {}),
    })
  }
  return {
    url,
    ...(typeof record.updatedAt === 'string' ? { observedAt: record.updatedAt } : {}),
    attempts,
  }
}

/** The browser journal's typed failure codes that mean a website refused a read. */
const DENIED_BROWSER_ERROR_CODES: Readonly<Record<string, DeniedOutcome>> =
  Object.freeze({
    access_challenge: 'challenge',
    access_denied: 'access-denied',
    rate_limited: 'rate-limited',
  })

/**
 * One managed-browser activity, as the browser journal stores it.
 *
 * `title` and `error.message` are read by nothing here on purpose. A browser
 * title is frequently the full search URL that led to the page, and a message
 * is free text, so neither belongs anywhere near a tracked fixture.
 *
 * `source_blocked` is not a denial. It is this application answering from a
 * stored lane ban, so counting it would inflate a host's history with our own
 * suppression rather than the website's behaviour.
 */
function readBrowserActivity(
  value: unknown,
): ValidatedActivity | 'no-source-url' | 'ignored' | null {
  if (!isUnknownRecord(value)) return null
  // The denial code is decided first, on purpose. Most rows in this journal are
  // `observe`, `screenshot`, `click` and the like, which carry no URL and are
  // not denials; asking about the URL first would report every one of them as a
  // rejected record and make a healthy scan look damaged.
  const error = isUnknownRecord(value.error) ? value.error : undefined
  const outcome = typeof error?.code === 'string'
    ? DENIED_BROWSER_ERROR_CODES[error.code]
    : undefined
  if (!outcome) return 'ignored'
  const url = typeof value.url === 'string' ? value.url : undefined
  if (!url) return 'no-source-url'
  const observedAt =
    typeof value.updatedAt === 'string' ? value.updatedAt : undefined
  return {
    url,
    ...(observedAt ? { observedAt } : {}),
    attempts: [{ outcome, ...(observedAt ? { startedAt: observedAt } : {}) }],
  }
}

function isDeniedOutcome(attempt: {
  readonly outcome: string
  readonly startedAt?: string
}): attempt is { readonly outcome: DeniedOutcome; readonly startedAt?: string } {
  return (DENIED_OUTCOMES as readonly string[]).includes(attempt.outcome)
}

type ProbeUrlResult =
  | { readonly kind: 'safe'; readonly host: string; readonly url: string }
  | { readonly kind: 'credentialed' }
  | { readonly kind: 'non-public' }
  | { readonly kind: 'non-https' }
  | { readonly kind: 'malformed' }

/**
 * The probe a live run is allowed to request for a host.
 *
 * A credential-bearing URL is refused outright rather than stripped: a tracked
 * fixture is reviewed and shared, and the safest thing to do with a secret in a
 * URL is not to carry the URL at all. Query and fragment are stripped, because
 * they carry the search that led there and nothing about reachability.
 */
export function safeProbeUrl(value: string): ProbeUrlResult {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { kind: 'malformed' }
  }
  if (url.username || url.password) return { kind: 'credentialed' }
  const host = url.hostname.toLocaleLowerCase()
  // Publicness is asked before the scheme so a loopback or private address is
  // reported as what it is rather than as one more plain-HTTP page.
  if (!isPublicHostname(host)) return { kind: 'non-public' }
  if (url.protocol !== 'https:') {
    return url.protocol === 'http:' ? { kind: 'non-https' } : { kind: 'malformed' }
  }
  return { kind: 'safe', host, url: `https://${host}${url.pathname}` }
}

function isPublicHostname(host: string): boolean {
  if (!host || host.includes('_') || !host.includes('.')) return false
  if (host.endsWith('.local') || host.endsWith('.localhost')) return false
  if (host === 'localhost') return false
  if (/^\[?::1\]?$/u.test(host)) return false
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)
  if (!ipv4) return true
  const [first, second] = [Number(ipv4[1]), Number(ipv4[2])]
  if (first === 10 || first === 127 || first === 0) return false
  if (first === 192 && second === 168) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 169 && second === 254) return false
  return true
}

/**
 * Whether a file on disk may be handed to the opt-in live runner.
 *
 * The tracked cohort is editable, and everything in it becomes a URL this
 * machine requests, so the guard re-derives each probe through `safeProbeUrl`
 * rather than trusting the file. An entry that names a loopback or private
 * address, plain HTTP, userinfo, a query, a fragment, or a hostname that
 * disagrees with its own URL is refused, as is one whose counts cannot be true.
 */
export function isDeniedHostCohort(value: unknown): value is DeniedHostCohort {
  if (!isUnknownRecord(value)) return false
  if (value.schemaVersion !== DENIED_HOST_COHORT_SCHEMA_VERSION) return false
  if (!Array.isArray(value.hosts)) return false
  return value.hosts.every(isDeniedHostEntry)
}

function isDeniedHostEntry(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false
  if (
    typeof value.host !== 'string' ||
    value.host.length === 0 ||
    typeof value.probeUrl !== 'string' ||
    typeof value.firstObservedAt !== 'string' ||
    typeof value.lastObservedAt !== 'string'
  ) {
    return false
  }
  const probe = safeProbeUrl(value.probeUrl)
  if (probe.kind !== 'safe') return false
  // The stored URL must already be the canonical safe form, so a reader cannot
  // request something the extractor would have stripped.
  if (probe.url !== value.probeUrl || probe.host !== value.host) return false

  const accessDenied = countOf(value.accessDenied)
  const challenge = countOf(value.challenge)
  const rateLimited = countOf(value.rateLimited)
  const deniedAttempts = countOf(value.deniedAttempts)
  const sessions = countOf(value.sessions)
  if (
    accessDenied === undefined ||
    challenge === undefined ||
    rateLimited === undefined ||
    deniedAttempts === undefined ||
    sessions === undefined
  ) {
    return false
  }
  if (deniedAttempts !== accessDenied + challenge + rateLimited) return false
  if (deniedAttempts < 1 || sessions < 1) return false
  return true
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}

// ---------------------------------------------------------------------------
// The filesystem edge. Everything above is pure.

const JOURNAL_FILE_NAMES: Readonly<Record<PersistedJournalKind, string>> =
  Object.freeze({
    'research-acquisition': 'research-acquisition.json',
    'browser-activity': 'browser-activity.json',
  })

export async function readPersistedActivityFiles(
  sessionsDirectory: string,
): Promise<readonly PersistedActivityFile[]> {
  const entries = await fs.readdir(sessionsDirectory, { withFileTypes: true })
  const files: PersistedActivityFile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const kind of Object.keys(JOURNAL_FILE_NAMES) as PersistedJournalKind[]) {
      const file = path.join(
        sessionsDirectory,
        entry.name,
        JOURNAL_FILE_NAMES[kind],
      )
      let raw: string
      try {
        raw = await fs.readFile(file, 'utf8')
      } catch {
        // A session that never used one of the two tools has no journal for it.
        continue
      }
      let contents: unknown
      try {
        contents = JSON.parse(raw)
      } catch {
        contents = null
      }
      files.push({ sessionId: entry.name, kind, contents })
    }
  }
  return files
}

async function main(argv: readonly string[]): Promise<number> {
  const sessions = readOption(argv, '--sessions')
  const out = readOption(argv, '--out')
  if (!sessions || !out) {
    process.stderr.write(
      'Usage: tsx scripts/extract-denied-browser-hosts.ts --sessions <dir> --out <file>\n',
    )
    return 2
  }
  const files = await readPersistedActivityFiles(sessions)
  const result = buildDeniedHostCohort(files)
  await fs.writeFile(
    out,
    `${JSON.stringify(result.cohort, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(
    [
      `files scanned: ${files.length}`,
      `hosts: ${result.cohort.hosts.length}`,
      `denied attempts: ${result.cohort.hosts.reduce(
        (total, entry) => total + entry.deniedAttempts,
        0,
      )}`,
      `rejected: ${JSON.stringify(result.rejected)}`,
      `written: ${out}`,
      '',
    ].join('\n'),
  )
  return 0
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2))
} else if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exitCode = await main(process.argv.slice(2))
}
