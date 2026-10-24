import assert from 'node:assert/strict'
import test from 'node:test'

import {
  providerUsageDiagnostic,
  readingRetiresUsageLimit,
  readProviderUsage,
  type ProviderUsageReading,
  type ProviderUsageSource,
  type ProviderUsageWindow,
} from '../../domains/provider/provider-usage.js'

/**
 * How much of a provider's allowance is already gone, from whoever knows.
 *
 * Health today answers "is the binary there and the model enabled", which is
 * the wrong question for an account that has run out: everything is installed,
 * enabled, and dead. The reading itself is always evidence from some past
 * moment, so nothing here is allowed to present it as the state now.
 *
 * The seam is deliberately not "read a file". Today's only source reads what a
 * CLI already wrote down, which is free; asking a provider directly would cost
 * a call, and that difference is the caller's decision to make, not the
 * source's. So every source states its price and the caller states its budget.
 */

function makeSource(
  overrides: Partial<ProviderUsageSource> & { provider: string },
): ProviderUsageSource {
  return {
    cost: 'free',
    read: async () => undefined,
    ...overrides,
  }
}

/**
 * One stated window unless a test says otherwise.
 *
 * `usedPercent`, `windowMinutes` and `resetsAt` describe that single window,
 * so the tests about one allowance read as they did before windows became a
 * list. `windows` replaces it outright for the tests that are about two.
 */
function reading(
  overrides: {
    provider?: string
    observedAt?: string
    observedAtIsUpperBound?: boolean
    usedPercent?: number
    windowMinutes?: number | undefined
    resetsAt?: string | undefined
    windows?: readonly ProviderUsageWindow[]
  } = {},
): ProviderUsageReading {
  const usedPercent = overrides.usedPercent ?? 82
  const windowMinutes =
    'windowMinutes' in overrides ? overrides.windowMinutes : 10080
  const resetsAt =
    'resetsAt' in overrides ? overrides.resetsAt : '2026-09-15T01:45:48.000Z'
  return {
    provider: overrides.provider ?? 'codex',
    observedAt: overrides.observedAt ?? '2026-09-10T16:00:00.000Z',
    ...(overrides.observedAtIsUpperBound === undefined
      ? {}
      : { observedAtIsUpperBound: overrides.observedAtIsUpperBound }),
    windows: overrides.windows ?? [
      {
        usedPercent,
        ...(windowMinutes === undefined ? {} : { windowMinutes }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ],
  }
}

test('a provider with no source at all is simply unknown, not unhealthy', async () => {
  assert.equal(
    await readProviderUsage({ provider: 'gemini', sources: [] }),
    undefined,
  )
})

test('a free source answers a caller that will not pay', async () => {
  const source = makeSource({
    provider: 'codex',
    cost: 'free',
    read: async () => reading(),
  })

  const answer = await readProviderUsage({
    provider: 'codex',
    sources: [source],
  })

  assert.equal(answer?.windows[0]?.usedPercent, 82)
})

test('a source that would cost money is skipped until a caller says it may pay', async () => {
  // The future second step: asking the provider directly rather than reading
  // what a CLI left behind. A sidebar render must never trigger that; a person
  // pressing "check now" may.
  let asked = 0
  const probe = makeSource({
    provider: 'codex',
    cost: 'billable',
    read: async () => {
      asked += 1
      return reading({ usedPercent: 91 })
    },
  })

  assert.equal(
    await readProviderUsage({ provider: 'codex', sources: [probe] }),
    undefined,
  )
  assert.equal(asked, 0, 'nothing was bought without being asked for')

  const paid = await readProviderUsage({
    provider: 'codex',
    sources: [probe],
    maxCost: 'billable',
  })

  assert.equal(paid?.windows[0]?.usedPercent, 91)
  assert.equal(asked, 1)
})

test('the cheapest source that can answer is the one that answers', async () => {
  let probed = 0
  const answer = await readProviderUsage({
    provider: 'codex',
    maxCost: 'billable',
    sources: [
      makeSource({
        provider: 'codex',
        cost: 'billable',
        read: async () => {
          probed += 1
          return reading({ usedPercent: 91 })
        },
      }),
      makeSource({
        provider: 'codex',
        cost: 'free',
        read: async () => reading({ usedPercent: 82 }),
      }),
    ],
  })

  assert.equal(answer?.windows[0]?.usedPercent, 82)
  assert.equal(probed, 0, 'a free answer makes a paid one unnecessary')
})

test('a source that fails is silent rather than fatal', async () => {
  const answer = await readProviderUsage({
    provider: 'codex',
    sources: [
      makeSource({
        provider: 'codex',
        read: async () => {
          throw new Error('rollout directory vanished mid-read')
        },
      }),
      makeSource({ provider: 'codex', read: async () => reading() }),
    ],
  })

  assert.equal(answer?.windows[0]?.usedPercent, 82)
})

test('an allowance close to spent warns, and names when it comes back', () => {
  const diagnostic = providerUsageDiagnostic(
    reading({ usedPercent: 82 }),
    { agentName: 'crypto-market-analyst' },
    new Date('2026-09-12T02:00:00.000Z'),
  )

  assert.ok(diagnostic)
  assert.equal(diagnostic.severity, 'warning')
  assert.equal(diagnostic.kind, 'usage_limit')
  assert.equal(diagnostic.subject.agentName, 'crypto-market-analyst')
  assert.equal(diagnostic.subject.provider, 'codex')
  assert.match(diagnostic.message, /82%/)
  assert.match(diagnostic.message, /2026-09-15/)
  // The reading is evidence from a past moment and says so, because a quota
  // only ever went up since it was taken.
  assert.match(diagnostic.message, /2026-09-10/)
})

test('an allowance already spent is an error until the window it belongs to resets', () => {
  // Usage cannot fall inside one window, so a full reading whose reset is still
  // ahead is not stale evidence — it is still true.
  const diagnostic = providerUsageDiagnostic(
    reading({ usedPercent: 100 }),
    { agentName: 'crypto-market-analyst' },
    new Date('2026-09-12T02:00:00.000Z'),
  )

  assert.ok(diagnostic)
  assert.equal(diagnostic.severity, 'error')
  assert.match(diagnostic.message, /2026-09-15/)
})

test('a reading whose window has already reset is worth nothing and says nothing', () => {
  assert.equal(
    providerUsageDiagnostic(
      reading({ usedPercent: 100 }),
      { agentName: 'crypto-market-analyst' },
      new Date('2026-09-16T00:00:00.000Z'),
    ),
    undefined,
  )
})

test('an allowance with room left is not worth mentioning', () => {
  assert.equal(
    providerUsageDiagnostic(
      reading({ usedPercent: 40 }),
      { agentName: 'crypto-market-analyst' },
      new Date('2026-09-12T02:00:00.000Z'),
    ),
    undefined,
  )
})

test('a reading with no stated reset is only ever a warning', () => {
  // Without a reset there is no moment at which the reading stops being true,
  // and no moment at which it starts being false either. Reporting that as a
  // blocking error would strand an agent on evidence that cannot expire.
  const diagnostic = providerUsageDiagnostic(
    reading({ usedPercent: 100, resetsAt: undefined }),
    { agentName: 'crypto-market-analyst' },
    new Date('2026-09-12T02:00:00.000Z'),
  )

  assert.ok(diagnostic)
  assert.equal(diagnostic.severity, 'warning')
})

/**
 * Two windows at once, which is what a provider actually states.
 *
 * A short cap and a long one expire at different moments and can disagree
 * about whether the account can work. Reducing them to one at the moment they
 * are read throws away the one that outlives the other, so the choice belongs
 * here, where the time is known.
 */

const NOW = new Date('2026-09-12T00:00:00.000Z')

test('a short window that has rolled over does not hide a long one that has not', () => {
  // The five-hourly cap was spent and has since reset; the weekly cap is still
  // most of the way gone. Answering from the expired window alone would call
  // the account free at a moment it is nearly out.
  const diagnostic = providerUsageDiagnostic(
    reading({
      windows: [
        { usedPercent: 100, windowMinutes: 300, resetsAt: '2026-09-11T23:00:00.000Z' },
        { usedPercent: 90, windowMinutes: 10080, resetsAt: '2026-09-20T00:00:00.000Z' },
      ],
    }),
    { agentName: 'crypto-market-analyst' },
    NOW,
  )

  assert.ok(diagnostic, 'the live weekly cap is still worth saying')
  assert.equal(diagnostic.severity, 'warning')
  assert.match(diagnostic.message, /90%/)
  assert.match(diagnostic.message, /weekly/)
})

test('a spent window with a stated reset outranks an equally spent one without', () => {
  // Both are full. Only one of them can ever come back, and that is the one
  // that can be reported as a blocking error rather than a standing warning —
  // so a tie on percentage must not be settled by which was stated first.
  const diagnostic = providerUsageDiagnostic(
    reading({
      windows: [
        { usedPercent: 100, windowMinutes: 300 },
        { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-20T00:00:00.000Z' },
      ],
    }),
    { agentName: 'crypto-market-analyst' },
    NOW,
  )

  assert.ok(diagnostic)
  assert.equal(diagnostic.severity, 'error')
  assert.match(diagnostic.message, /weekly/)
})

test('every window having rolled over leaves nothing to say', () => {
  assert.equal(
    providerUsageDiagnostic(
      reading({
        windows: [
          { usedPercent: 100, windowMinutes: 300, resetsAt: '2026-09-11T22:00:00.000Z' },
          { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-11T23:00:00.000Z' },
        ],
      }),
      { agentName: 'crypto-market-analyst' },
      NOW,
    ),
    undefined,
  )
})

/**
 * Whether a reading may retire a usage limit a run actually hit.
 *
 * This is the only thing that can clear one for a provider nothing pings, and
 * clearing it is durable — so each condition below is a way the argument fails
 * rather than a preference.
 */

const FAILED_AT = '2026-09-11T09:00:00.000Z'

test('a later reading with room left retires the limit', () => {
  assert.equal(
    readingRetiresUsageLimit({
      reading: reading({ observedAt: '2026-09-11T23:00:00.000Z', usedPercent: 17 }),
      failedAt: FAILED_AT,
      now: NOW,
    }),
    true,
  )
})

test('an earlier reading never retires the limit', () => {
  // The failure is the newer account of the same windows, so the reading has
  // nothing to add. Without this a run that died at noon would be cleared by
  // the morning's reading on every render.
  assert.equal(
    readingRetiresUsageLimit({
      reading: reading({ observedAt: '2026-09-11T08:00:00.000Z', usedPercent: 17 }),
      failedAt: FAILED_AT,
      now: NOW,
    }),
    false,
  )
})

test('a reading dated only by an upper bound never retires the limit', () => {
  // An upper bound says the answer was written no later than this, which
  // cannot establish that it was written after the failure — and that is the
  // whole of the claim being made.
  assert.equal(
    readingRetiresUsageLimit({
      reading: reading({
        observedAt: '2026-09-11T23:00:00.000Z',
        observedAtIsUpperBound: true,
        usedPercent: 17,
      }),
      failedAt: FAILED_AT,
      now: NOW,
    }),
    false,
  )
})

test('a later reading still holding a spent window never retires the limit', () => {
  // A fresh five-hourly window says nothing about an exhausted weekly one, and
  // the limit the run hit may well have been the weekly one.
  assert.equal(
    readingRetiresUsageLimit({
      reading: reading({
        observedAt: '2026-09-11T23:00:00.000Z',
        windows: [
          { usedPercent: 3, windowMinutes: 300, resetsAt: '2026-09-12T04:00:00.000Z' },
          { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-20T00:00:00.000Z' },
        ],
      }),
      failedAt: FAILED_AT,
      now: NOW,
    }),
    false,
  )
})

test('a spent window that has since rolled over does not block retirement', () => {
  assert.equal(
    readingRetiresUsageLimit({
      reading: reading({
        observedAt: '2026-09-11T23:00:00.000Z',
        windows: [
          { usedPercent: 100, windowMinutes: 300, resetsAt: '2026-09-11T23:30:00.000Z' },
        ],
      }),
      failedAt: FAILED_AT,
      now: NOW,
    }),
    true,
  )
})

test('a later reading spent with no stated reset never retires the limit', () => {
  // The display rule and the recovery rule ask different questions of the same
  // window. Calling an account blocked needs a reset, because a full window
  // that never says when it comes back would strand an agent forever — so that
  // stays a warning. Retiring a limit a run actually hit needs evidence of
  // headroom, and a window at 100% is evidence of the opposite whether or not
  // it says when it ends.
  assert.equal(
    readingRetiresUsageLimit({
      reading: reading({
        observedAt: '2026-09-11T23:00:00.000Z',
        windows: [{ usedPercent: 100, windowMinutes: 10080 }],
      }),
      failedAt: FAILED_AT,
      now: NOW,
    }),
    false,
  )
})
