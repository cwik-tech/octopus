import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import {
  DENIED_HOST_COHORT_SCHEMA_VERSION,
  buildDeniedHostCohort,
  isDeniedHostCohort,
} from '../../scripts/extract-denied-browser-hosts.js'

/**
 * The cohort the opt-in live measurement is allowed to touch.
 *
 * Every literal below is written as a persisted file would arrive: unknown JSON
 * that has to be validated before use. The expected result is stated
 * independently, host by host, rather than derived by re-running the same
 * aggregation.
 */

const SESSION_ONE = [
  {
    activityId: 'a1',
    action: 'acquire',
    requestedUrl: 'https://www.example-denied.test/search?q=shoes&loc=Detroit#top',
    attempts: [
      { method: 'direct-http', outcome: 'access-denied', startedAt: '2026-08-20T10:00:00.000Z' },
      { method: 'direct-http-proxied', outcome: 'access-denied', startedAt: '2026-08-20T10:00:01.000Z' },
      { method: 'managed-browser', outcome: 'challenge', startedAt: '2026-08-20T10:00:02.000Z' },
    ],
  },
  {
    activityId: 'a2',
    action: 'acquire',
    requestedUrl: 'https://www.example-denied.test/biz/alpha',
    attempts: [
      { method: 'direct-http', outcome: 'rate-limited', startedAt: '2026-08-21T09:00:00.000Z' },
      { method: 'managed-browser', outcome: 'usable', startedAt: '2026-08-21T09:00:04.000Z' },
    ],
  },
  {
    activityId: 'a3',
    action: 'acquire',
    requestedUrl: 'https://redacted:redacted@www.credentialed.test/report',
    attempts: [
      { method: 'direct-http', outcome: 'access-denied', startedAt: '2026-08-21T09:10:00.000Z' },
    ],
  },
  {
    activityId: 'a4',
    action: 'acquire',
    requestedUrl: 'http://127.0.0.1:8080/loopback',
    attempts: [
      { method: 'direct-http', outcome: 'access-denied', startedAt: '2026-08-21T09:11:00.000Z' },
    ],
  },
  {
    activityId: 'a5',
    action: 'acquire',
    requestedUrl: 'http://insecure.test/report',
    attempts: [
      { method: 'direct-http', outcome: 'challenge', startedAt: '2026-08-21T09:12:00.000Z' },
    ],
  },
  {
    activityId: 'a6',
    action: 'acquire',
    requestedUrl: 'not a url at all',
    attempts: [
      { method: 'direct-http', outcome: 'access-denied', startedAt: '2026-08-21T09:13:00.000Z' },
    ],
  },
  { activityId: 'a7', action: 'acquire', requestedUrl: 'https://www.malformed.test/x', attempts: 'not-an-array' },
  { activityId: 'a8', action: 'search', attempts: [{ method: 'direct-http', outcome: 'access-denied' }] },
  'this record is not even an object',
]

const SESSION_TWO = [
  {
    activityId: 'b1',
    action: 'acquire',
    requestedUrl: 'https://WWW.Example-Denied.test/biz/beta',
    attempts: [
      { method: 'direct-http', outcome: 'access-denied', startedAt: '2026-08-25T12:00:00.000Z' },
    ],
  },
  {
    activityId: 'b2',
    action: 'acquire',
    requestedUrl: 'https://second.example-blocked.test/a/page',
    attempts: [
      { method: 'managed-browser-proxied', outcome: 'challenge', startedAt: '2026-08-19T08:00:00.000Z' },
    ],
  },
]

/**
 * The second persisted schema.
 *
 * The managed browser keeps its own journal, with a flat `url` and a typed
 * `error.code` rather than an attempts array. It is the larger population by
 * file count, so a cohort built from acquisition journals alone is not the
 * denied-host history — it is one slice of it.
 *
 * `title` is deliberately loaded with a query here: the browser journal stores
 * the page title, which for a search interstitial is the search URL, and none
 * of it may reach the tracked fixture.
 */
const BROWSER_SESSION = [
  {
    activityId: 'c1',
    action: 'open',
    state: 'failed',
    url: 'https://www.browser-blocked.test/sorry/index',
    title: 'https://www.browser-blocked.test/search?q=private+query',
    updatedAt: '2026-08-18T09:00:00.000Z',
    error: { code: 'access_challenge', message: 'The source presented a CAPTCHA.' },
  },
  {
    activityId: 'c2',
    action: 'open',
    state: 'failed',
    url: 'https://www.example-denied.test/browser/page?utm=1#frag',
    updatedAt: '2026-08-26T09:00:00.000Z',
    error: { code: 'rate_limited', message: 'Too many requests.' },
  },
  {
    // A stored lane ban, not a fresh denial by the website.
    activityId: 'c3',
    action: 'open',
    state: 'failed',
    url: 'https://www.browser-blocked.test/another',
    updatedAt: '2026-08-18T09:01:00.000Z',
    error: { code: 'source_blocked', message: 'This host is blocked for the rest of the turn.' },
  },
  {
    activityId: 'c4',
    action: 'open',
    state: 'completed',
    url: 'https://www.browser-usable.test/report',
    updatedAt: '2026-08-18T09:02:00.000Z',
  },
  {
    activityId: 'c5',
    action: 'open',
    state: 'failed',
    url: 'http://127.0.0.1:8080/loopback',
    updatedAt: '2026-08-18T09:03:00.000Z',
    error: { code: 'access_denied', message: 'Denied.' },
  },
  { activityId: 'c6', action: 'observe', state: 'failed', error: { code: 'access_denied', message: 'Denied.' } },
  // The ordinary shape of this journal: an in-page action with no URL and no
  // denial. It must be ignored rather than reported as a rejected record.
  { activityId: 'c7', action: 'observe', state: 'completed', updatedAt: '2026-08-18T09:04:00.000Z' },
]

test('the browser journal contributes denied hosts and unions with acquisition counts', () => {
  const result = buildDeniedHostCohort([
    { sessionId: 'session-one', kind: 'research-acquisition', contents: SESSION_ONE },
    { sessionId: 'session-browser', kind: 'browser-activity', contents: BROWSER_SESSION },
  ])

  const byHost = new Map(result.cohort.hosts.map((entry) => [entry.host, entry]))
  assert.deepEqual(
    [...byHost.keys()],
    ['www.browser-blocked.test', 'www.example-denied.test'],
    'a browser-only host joins the cohort and a usable one does not',
  )

  // Only `c1` counts: `c3` is a stored lane ban and `c4` succeeded.
  assert.deepEqual(byHost.get('www.browser-blocked.test'), {
    host: 'www.browser-blocked.test',
    probeUrl: 'https://www.browser-blocked.test/sorry/index',
    deniedAttempts: 1,
    accessDenied: 0,
    challenge: 1,
    rateLimited: 0,
    sessions: 1,
    firstObservedAt: '2026-08-18T09:00:00.000Z',
    lastObservedAt: '2026-08-18T09:00:00.000Z',
  })

  // Session one alone records two access denials, one challenge and one rate
  // limit for this host; the browser journal adds a second rate limit from a
  // different session.
  assert.deepEqual(byHost.get('www.example-denied.test'), {
    host: 'www.example-denied.test',
    probeUrl: 'https://www.example-denied.test/biz/alpha',
    deniedAttempts: 5,
    accessDenied: 2,
    challenge: 1,
    rateLimited: 2,
    sessions: 2,
    firstObservedAt: '2026-08-20T10:00:00.000Z',
    lastObservedAt: '2026-08-26T09:00:00.000Z',
  })

  assert.doesNotMatch(
    JSON.stringify(result.cohort),
    /private\+query|utm=1|frag|sorry\/index\?/u,
    'no title, query, or fragment reaches the tracked cohort',
  )
})

test('the browser journal accounts for every record it refused', () => {
  const result = buildDeniedHostCohort([
    { sessionId: 'session-browser', kind: 'browser-activity', contents: BROWSER_SESSION },
    { sessionId: 'session-browser-broken', kind: 'browser-activity', contents: 'not an array' },
  ])

  // `c6` is a denial with no URL, and `c5` names a loopback address. `c7` is an
  // ordinary URL-less action and is ignored rather than counted.
  assert.deepEqual(result.rejected, {
    unreadableFiles: 1,
    recordsWithoutSourceUrl: 1,
    malformedRecords: 0,
    credentialBearingUrls: 0,
    nonPublicUrls: 1,
    nonHttpsUrls: 0,
  })
})

test('the extractor emits one redacted entry per safe public denied host', () => {
  const result = buildDeniedHostCohort([
    { sessionId: 'session-one', kind: 'research-acquisition', contents: SESSION_ONE },
    { sessionId: 'session-two', kind: 'research-acquisition', contents: SESSION_TWO },
    { sessionId: 'session-broken', kind: 'research-acquisition', contents: { activities: 'not an array' } },
  ])

  assert.deepEqual(result.cohort, {
    schemaVersion: DENIED_HOST_COHORT_SCHEMA_VERSION,
    hosts: [
      {
        host: 'second.example-blocked.test',
        probeUrl: 'https://second.example-blocked.test/a/page',
        deniedAttempts: 1,
        accessDenied: 0,
        challenge: 1,
        rateLimited: 0,
        sessions: 1,
        firstObservedAt: '2026-08-19T08:00:00.000Z',
        lastObservedAt: '2026-08-19T08:00:00.000Z',
      },
      {
        host: 'www.example-denied.test',
        probeUrl: 'https://www.example-denied.test/biz/alpha',
        deniedAttempts: 5,
        accessDenied: 3,
        challenge: 1,
        rateLimited: 1,
        sessions: 2,
        firstObservedAt: '2026-08-20T10:00:00.000Z',
        lastObservedAt: '2026-08-25T12:00:00.000Z',
      },
    ],
  })
})

test('the extractor accounts for every record it refused', () => {
  const result = buildDeniedHostCohort([
    { sessionId: 'session-one', kind: 'research-acquisition', contents: SESSION_ONE },
    { sessionId: 'session-two', kind: 'research-acquisition', contents: SESSION_TWO },
    { sessionId: 'session-broken', kind: 'research-acquisition', contents: { activities: 'not an array' } },
  ])

  // `a8` is an ordinary search activity with no source URL, which is the common
  // case in a real journal and is counted apart from a malformed record. Three
  // records are malformed: `a7` has no attempts array, one entry is a bare
  // string, and `a6`'s URL does not parse.
  assert.deepEqual(result.rejected, {
    unreadableFiles: 1,
    recordsWithoutSourceUrl: 1,
    malformedRecords: 3,
    credentialBearingUrls: 1,
    nonPublicUrls: 1,
    nonHttpsUrls: 1,
  })
})

test('no query, fragment, or userinfo survives into a probe URL', () => {
  const result = buildDeniedHostCohort([
    {
      sessionId: 'session-query-only',
      kind: 'research-acquisition',
      contents: [
        {
          activityId: 'q1',
          action: 'acquire',
          requestedUrl: 'https://www.query-only.test/search?cflt=sushi&find_loc=Ann+Arbor#results',
          attempts: [
            { method: 'direct-http', outcome: 'access-denied', startedAt: '2026-08-22T00:00:00.000Z' },
          ],
        },
      ],
    },
  ])

  assert.equal(result.cohort.hosts.length, 1)
  assert.equal(
    result.cohort.hosts[0]?.probeUrl,
    'https://www.query-only.test/search',
  )
})

/**
 * What the guard has to refuse.
 *
 * The tracked fixture is the only list the opt-in live runner will request, and
 * it is an editable file on disk. A guard that checked types alone would let an
 * edited fixture aim the runner at loopback, a private address, plain HTTP, or a
 * URL carrying credentials, so each of those is refused by shape rather than by
 * trusting whoever wrote the file.
 */
const UNSAFE_COHORT_ENTRIES = [
  { why: 'loopback host', probeUrl: 'https://127.0.0.1/report', host: '127.0.0.1' },
  { why: 'private address', probeUrl: 'https://192.168.1.4/report', host: '192.168.1.4' },
  { why: 'plain HTTP', probeUrl: 'http://www.blocked.test/report', host: 'www.blocked.test' },
  { why: 'userinfo', probeUrl: 'https://redacted:redacted@www.blocked.test/report', host: 'www.blocked.test' },
  { why: 'query string', probeUrl: 'https://www.blocked.test/report?q=1', host: 'www.blocked.test' },
  { why: 'fragment', probeUrl: 'https://www.blocked.test/report#top', host: 'www.blocked.test' },
  { why: 'host that disagrees with the URL', probeUrl: 'https://elsewhere.test/report', host: 'www.blocked.test' },
  { why: 'unparseable URL', probeUrl: 'not a url', host: 'www.blocked.test' },
] as const

function makeCohortEntry(overrides: Record<string, unknown> = {}): unknown {
  return {
    host: 'www.blocked.test',
    probeUrl: 'https://www.blocked.test/report',
    deniedAttempts: 3,
    accessDenied: 1,
    challenge: 1,
    rateLimited: 1,
    sessions: 2,
    firstObservedAt: '2026-08-20T10:00:00.000Z',
    lastObservedAt: '2026-08-25T12:00:00.000Z',
    ...overrides,
  }
}

test('a cohort that would aim the live runner at an unsafe URL is refused', () => {
  assert.equal(
    isDeniedHostCohort({
      schemaVersion: DENIED_HOST_COHORT_SCHEMA_VERSION,
      hosts: [makeCohortEntry()],
    }),
    true,
    'the safe baseline entry must still be accepted',
  )
  for (const unsafe of UNSAFE_COHORT_ENTRIES) {
    assert.equal(
      isDeniedHostCohort({
        schemaVersion: DENIED_HOST_COHORT_SCHEMA_VERSION,
        hosts: [makeCohortEntry({ probeUrl: unsafe.probeUrl, host: unsafe.host })],
      }),
      false,
      `a cohort with a ${unsafe.why} must be refused`,
    )
  }
})

test('a cohort whose counts cannot be true is refused', () => {
  for (const [why, overrides] of [
    ['a negative count', { accessDenied: -1, deniedAttempts: 1 }],
    ['a fractional count', { challenge: 1.5, deniedAttempts: 3.5 }],
    ['a total that does not match its parts', { deniedAttempts: 9 }],
    ['no session', { sessions: 0 }],
    ['a non-numeric count', { sessions: '2' }],
  ] as const) {
    assert.equal(
      isDeniedHostCohort({
        schemaVersion: DENIED_HOST_COHORT_SCHEMA_VERSION,
        hosts: [makeCohortEntry(overrides)],
      }),
      false,
      `a cohort with ${why} must be refused`,
    )
  }
})

test('the tracked cohort fixture matches the schema the live runner reads', () => {
  const tracked: unknown = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'tests', 'fixtures', 'browser-denied-hosts.json'),
      'utf8',
    ),
  )

  assert.ok(isDeniedHostCohort(tracked), 'the tracked fixture must parse as a cohort')
  assert.deepEqual(
    tracked.hosts.map((entry) => entry.host),
    [...tracked.hosts.map((entry) => entry.host)].sort(),
    'entries stay sorted by hostname so a refresh has a stable diff',
  )
  for (const entry of tracked.hosts) {
    const url = new URL(entry.probeUrl)
    assert.equal(url.protocol, 'https:', entry.host)
    assert.equal(url.hostname, entry.host, entry.host)
    assert.equal(url.search, '', entry.host)
    assert.equal(url.hash, '', entry.host)
    assert.equal(url.username, '', entry.host)
    assert.equal(url.password, '', entry.host)
    assert.equal(
      entry.deniedAttempts,
      entry.accessDenied + entry.challenge + entry.rateLimited,
      entry.host,
    )
  }
})
