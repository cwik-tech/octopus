import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { createCodexRolloutUsageSource } from '../../domains/provider/codex-usage-source.js'

/**
 * What the Codex CLI already wrote down about the account it was using.
 *
 * Codex records the provider's own rate-limit answer into each session's
 * rollout log, so the number a run would discover the hard way is already on
 * disk. Reading it costs nothing and asks the provider for nothing.
 *
 * It is somebody else's private log format, so every rule here is written to
 * fail closed: anything unrecognized produces no reading at all rather than a
 * guess, because a badge that invents a limit is worse than a badge that
 * stays quiet.
 */

interface RateLimitWindow {
  readonly used_percent?: unknown
  readonly window_minutes?: unknown
  readonly resets_at?: unknown
}

interface RateLimits {
  readonly primary?: RateLimitWindow | null
  readonly secondary?: RateLimitWindow | null
}

const ANSWERED_AT = '2026-09-10T16:00:00.000Z'

function tokenCountLine(
  rateLimits: RateLimits,
  timestamp: unknown = ANSWERED_AT,
): string {
  return JSON.stringify({
    ...(timestamp === undefined ? {} : { timestamp }),
    ordinal: 7,
    type: 'event_msg',
    payload: { type: 'token_count', info: {}, rate_limits: rateLimits },
  })
}

/**
 * The one modification time every fixture rollout is written with.
 *
 * Two rollouts written microseconds apart share an mtime on Linux, whose inode
 * clock ticks far more coarsely than the writes do, and do not share one on
 * APFS. Left to the filesystem, the ordering these tests are about would
 * therefore be decided by a different thing on a developer's machine than on
 * the runner — and only the runner would notice a reader that cannot break the
 * tie. Pinning makes the tie happen everywhere, on purpose, every run.
 */
const ROLLOUT_MTIME = new Date('2026-09-11T12:00:00.000Z')

type Rollout = readonly string[] | { readonly lines: readonly string[]; readonly mtime: Date }

function withCodexHome(
  rollouts: Record<string, Rollout>,
  run: (codexHome: string) => Promise<void>,
): Promise<void> {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'))
  for (const [relativePath, rollout] of Object.entries(rollouts)) {
    const lines = 'lines' in rollout ? rollout.lines : rollout
    const mtime = 'mtime' in rollout ? rollout.mtime : ROLLOUT_MTIME
    const filePath = path.join(codexHome, 'sessions', relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`)
    fs.utimesSync(filePath, mtime, mtime)
  }
  return run(codexHome).finally(() => {
    fs.rmSync(codexHome, { recursive: true, force: true })
  })
}

const FULL_WEEK = {
  primary: {
    used_percent: 82,
    window_minutes: 10080,
    resets_at: 1789436748,
  },
}

test('the Codex rollout reader states what the provider last said about the allowance', async () => {
  await withCodexHome(
    { '2026/09/10/rollout-2026-09-10T16-00-00-aaa.jsonl': [tokenCountLine(FULL_WEEK)] },
    async (codexHome) => {
      const source = createCodexRolloutUsageSource({ codexHome })

      assert.equal(source.provider, 'codex')
      assert.equal(source.cost, 'free')

      const reading = await source.read()
      assert.ok(reading)
      assert.equal(reading.provider, 'codex')
      assert.deepEqual(reading.windows, [
        {
          usedPercent: 82,
          windowMinutes: 10080,
          resetsAt: new Date(1789436748 * 1000).toISOString(),
        },
      ])
    },
  )
})

test('a reading is dated by the answer, not by when the file was last touched', async () => {
  // The rollout keeps growing after the provider states an allowance: more
  // turns, more messages, a newer modification time, and the same stale
  // number. Dating the reading by the file would let an old answer look like
  // a fresh one, and a fresh reading is exactly what is allowed to retire a
  // usage limit a run actually hit — so the file's clock must not be the
  // reading's clock.
  await withCodexHome(
    { '2026/09/10/rollout-2026-09-10T16-00-00-aaa.jsonl': [tokenCountLine(FULL_WEEK)] },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.ok(reading)
      assert.equal(reading.observedAt, ANSWERED_AT)
      assert.notEqual(reading.observedAt, ROLLOUT_MTIME.toISOString())
    },
  )
})

test('an answer with no readable date is marked as only an upper bound', async () => {
  // The modification time is a true upper bound on when the answer was
  // written, which is enough to say how much of an allowance is gone and not
  // enough to place the reading after anything else. Marked rather than
  // discarded, so it can still warn without being mistaken for proof that a
  // failure came first.
  await withCodexHome(
    {
      '2026/09/10/rollout-2026-09-10T16-00-00-aaa.jsonl': [
        tokenCountLine(FULL_WEEK, 'not a timestamp'),
      ],
    },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.ok(reading)
      assert.equal(reading.observedAt, ROLLOUT_MTIME.toISOString())
      assert.equal(reading.observedAtIsUpperBound, true)
    },
  )
})

test('a dated answer is not marked as an upper bound', async () => {
  await withCodexHome(
    { '2026/09/10/rollout-2026-09-10T16-00-00-aaa.jsonl': [tokenCountLine(FULL_WEEK)] },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.ok(reading)
      assert.notEqual(reading.observedAtIsUpperBound, true)
    },
  )
})

test('both stated windows are kept, not reduced to the worse of them', async () => {
  // Codex states two allowances at once: a short window and a long one. They
  // expire at different moments, so collapsing them here would throw away the
  // one that outlives the other — and the reader, who knows what time it is,
  // is the only party that can say which binds now.
  await withCodexHome(
    {
      '2026/09/10/rollout-2026-09-10T16-00-00-aaa.jsonl': [
        tokenCountLine({
          primary: { used_percent: 17, window_minutes: 300, resets_at: 1789000000 },
          secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1789436748 },
        }),
      ],
    },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.ok(reading)
      assert.deepEqual(reading.windows, [
        {
          usedPercent: 17,
          windowMinutes: 300,
          resetsAt: new Date(1789000000 * 1000).toISOString(),
        },
        {
          usedPercent: 100,
          windowMinutes: 10080,
          resetsAt: new Date(1789436748 * 1000).toISOString(),
        },
      ])
    },
  )
})

test('a stated secondary window with less spent does not hide the primary', async () => {
  await withCodexHome(
    {
      '2026/09/10/rollout-2026-09-10T16-00-00-aaa.jsonl': [
        tokenCountLine({
          primary: { used_percent: 96, window_minutes: 300, resets_at: 1789000000 },
          secondary: { used_percent: 4, window_minutes: 10080, resets_at: 1789436748 },
        }),
      ],
    },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.ok(reading)
      assert.deepEqual(
        reading.windows.map((window) => window.usedPercent),
        [96, 4],
      )
    },
  )
})

test('the newest session wins, whatever order the directories are walked in', async () => {
  await withCodexHome(
    {
      '2026/09/09/rollout-2026-09-09T10-00-00-old.jsonl': [
        tokenCountLine({ primary: { ...FULL_WEEK.primary, used_percent: 10 } }),
      ],
      '2026/09/11/rollout-2026-09-11T10-00-00-new.jsonl': [
        tokenCountLine({ primary: { ...FULL_WEEK.primary, used_percent: 97 } }),
      ],
    },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.equal(reading?.windows[0]?.usedPercent, 97)
    },
  )
})

test('a session written to more recently wins over one whose name is later', async () => {
  // A session opened on the 9th and still being worked in states a newer
  // allowance than one opened on the 11th and abandoned. The name a session was
  // filed under only decides which of two equally recent files is newer; it
  // never overrules the file that was actually written to last.
  await withCodexHome(
    {
      '2026/09/09/rollout-2026-09-09T10-00-00-resumed.jsonl': [
        tokenCountLine({ primary: { ...FULL_WEEK.primary, used_percent: 97 } }),
      ],
      '2026/09/11/rollout-2026-09-11T10-00-00-abandoned.jsonl': [
        tokenCountLine({ primary: { ...FULL_WEEK.primary, used_percent: 10 } }),
      ],
    },
    async (codexHome) => {
      const resumed = path.join(
        codexHome,
        'sessions',
        '2026/09/09/rollout-2026-09-09T10-00-00-resumed.jsonl',
      )
      const writtenLater = new Date(ROLLOUT_MTIME.getTime() + 60_000)
      fs.utimesSync(resumed, writtenLater, writtenLater)

      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.equal(reading?.windows[0]?.usedPercent, 97)
    },
  )
})

test('the last answer in a session wins, because the allowance only moved on', async () => {
  await withCodexHome(
    {
      '2026/09/10/rollout-2026-09-10T16-00-00-aaa.jsonl': [
        tokenCountLine({ primary: { ...FULL_WEEK.primary, used_percent: 40 } }),
        tokenCountLine({ primary: { ...FULL_WEEK.primary, used_percent: 55 } }),
      ],
    },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.equal(reading?.windows[0]?.usedPercent, 55)
    },
  )
})

test('a session that stated no allowance is skipped for one that did', async () => {
  // Real rollouts end on a `token_count` whose `primary` is null — a session
  // that opened and never completed a turn. Reading only the final entry would
  // therefore find nothing on exactly the sessions a user just started.
  await withCodexHome(
    {
      '2026/09/09/rollout-2026-09-09T10-00-00-real.jsonl': [
        tokenCountLine({ primary: { ...FULL_WEEK.primary, used_percent: 64 } }),
      ],
      '2026/09/11/rollout-2026-09-11T10-00-00-empty.jsonl': [
        tokenCountLine({ primary: null }),
      ],
    },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.equal(reading?.windows[0]?.usedPercent, 64)
    },
  )
})

test('a machine that has never run Codex produces no reading rather than an error', async () => {
  const reading = await createCodexRolloutUsageSource({
    codexHome: path.join(os.tmpdir(), 'codex-usage-absent-fixture'),
  }).read()

  assert.equal(reading, undefined)
})

for (const [name, rateLimits] of [
  ['a percentage outside 0-100', { primary: { ...FULL_WEEK.primary, used_percent: 140 } }],
  ['a percentage that is not a number', { primary: { ...FULL_WEEK.primary, used_percent: 'lots' } }],
  ['a reset that is not a timestamp', { primary: { ...FULL_WEEK.primary, resets_at: 'soon' } }],
  ['no primary window at all', { primary: null }],
  ['nothing recognizable', {}],
] as const) {
  test(`a rollout stating ${name} produces no reading at all`, async () => {
    await withCodexHome(
      { '2026/09/10/rollout-2026-09-10T16-00-00-aaa.jsonl': [tokenCountLine(rateLimits)] },
      async (codexHome) => {
        assert.equal(
          await createCodexRolloutUsageSource({ codexHome }).read(),
          undefined,
        )
      },
    )
  })
}

test('a rollout too large to hold in memory is still read', async () => {
  // Real ones reach hundreds of megabytes. The reader takes the end of the
  // file, where the newest answer is, rather than the whole of it.
  await withCodexHome({}, async (codexHome) => {
    const filePath = path.join(
      codexHome,
      'sessions',
      '2026/09/10/rollout-2026-09-10T16-00-00-big.jsonl',
    )
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const filler = `${JSON.stringify({ type: 'event_msg', payload: { type: 'other', pad: 'x'.repeat(4096) } })}\n`
    const handle = fs.openSync(filePath, 'w')
    for (let written = 0; written < 4000; written += 1) {
      fs.writeSync(handle, filler)
    }
    fs.writeSync(handle, `${tokenCountLine(FULL_WEEK)}\n`)
    fs.closeSync(handle)

    assert.ok(fs.statSync(filePath).size > 8 * 1024 * 1024)
    const reading = await createCodexRolloutUsageSource({ codexHome }).read()

    assert.equal(reading?.windows[0]?.usedPercent, 82)
  })
})

test('the newest answer wins across files, not the most recently touched file', async () => {
  // A session stays open and keeps being appended to long after it last heard
  // an allowance, so the file written most recently is routinely not the file
  // holding the newest answer. Choosing by modification time would return the
  // stale healthy number and let it retire a limit the newer, spent answer
  // still supports.
  await withCodexHome(
    {
      '2026/09/11/rollout-2026-09-11T09-00-00-touched.jsonl': {
        lines: [
          tokenCountLine(
            { primary: { used_percent: 17, window_minutes: 10080, resets_at: 1789436748 } },
            '2026-09-11T09:10:00.000Z',
          ),
        ],
        mtime: new Date('2026-09-11T09:40:00.000Z'),
      },
      '2026/09/11/rollout-2026-09-11T09-20-00-answered.jsonl': {
        lines: [
          tokenCountLine(
            { primary: { used_percent: 100, window_minutes: 10080, resets_at: 1789436748 } },
            '2026-09-11T09:30:00.000Z',
          ),
        ],
        mtime: new Date('2026-09-11T09:30:00.000Z'),
      },
    },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.ok(reading)
      assert.equal(reading.observedAt, '2026-09-11T09:30:00.000Z')
      assert.equal(reading.windows[0]?.usedPercent, 100)
    },
  )
})

test('an undated answer loses to a dated one, however recently its file changed', async () => {
  await withCodexHome(
    {
      '2026/09/11/rollout-2026-09-11T09-00-00-undated.jsonl': {
        lines: [
          tokenCountLine(
            { primary: { used_percent: 17, window_minutes: 10080, resets_at: 1789436748 } },
            'not a timestamp',
          ),
        ],
        mtime: new Date('2026-09-11T09:40:00.000Z'),
      },
      '2026/09/11/rollout-2026-09-11T09-20-00-dated.jsonl': {
        lines: [
          tokenCountLine(
            { primary: { used_percent: 100, window_minutes: 10080, resets_at: 1789436748 } },
            '2026-09-11T09:30:00.000Z',
          ),
        ],
        mtime: new Date('2026-09-11T09:30:00.000Z'),
      },
    },
    async (codexHome) => {
      const reading = await createCodexRolloutUsageSource({ codexHome }).read()

      assert.ok(reading)
      assert.notEqual(reading.observedAtIsUpperBound, true)
      assert.equal(reading.windows[0]?.usedPercent, 100)
    },
  )
})
