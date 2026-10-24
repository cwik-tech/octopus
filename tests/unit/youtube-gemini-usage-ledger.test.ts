import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { YoutubeGeminiUsageLedger } from '../../services/youtube-gemini-usage-ledger.js'

test('concurrent reservations are serialized against one rolling 24-hour limit', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-ledger-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ledger = new YoutubeGeminiUsageLedger({
    storagePath: path.join(directory, 'usage.json'),
    now: () => new Date('2026-08-12T12:00:00.000Z'),
  })

  const [first, second] = await Promise.all([
    ledger.reserve({ runId: 'run-a', videoId: 'video-a', estimatedMinutes: 70, limitMinutes: 120 }),
    ledger.reserve({ runId: 'run-b', videoId: 'video-b', estimatedMinutes: 70, limitMinutes: 120 }),
  ])

  assert.equal([first.accepted, second.accepted].filter(Boolean).length, 1)
  assert.equal([first.accepted, second.accepted].filter((accepted) => !accepted).length, 1)
  assert.equal((await ledger.rollingUsage()).reservedMinutes, 70)
})

test('failed requests release reservations and completed usage expires after 24 hours', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-ledger-time-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  let current = new Date('2026-08-12T12:00:00.000Z')
  const storagePath = path.join(directory, 'usage.json')
  const ledger = new YoutubeGeminiUsageLedger({ storagePath, now: () => current })

  assert.equal((await ledger.reserve({
    runId: 'run-failed', videoId: 'video-failed', estimatedMinutes: 25, limitMinutes: 120,
  })).accepted, true)
  await ledger.release('run-failed')
  assert.equal((await ledger.rollingUsage()).totalMinutes, 0)

  await ledger.reserve({
    runId: 'run-complete', videoId: 'video-complete', estimatedMinutes: 45, limitMinutes: 120,
  })
  await ledger.complete('run-complete', { actualMinutes: 40, inputTokens: 100, outputTokens: 20 })
  assert.equal((await ledger.rollingUsage()).completedMinutes, 40)

  current = new Date('2026-08-13T12:00:00.001Z')
  const reloaded = new YoutubeGeminiUsageLedger({ storagePath, now: () => current })
  assert.equal((await reloaded.rollingUsage()).totalMinutes, 0)
})

test('an explicitly confirmed run may reserve beyond the rolling warning limit', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-gemini-ledger-confirmed-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ledger = new YoutubeGeminiUsageLedger({
    storagePath: path.join(directory, 'usage.json'),
    now: () => new Date('2026-08-12T12:00:00.000Z'),
  })
  await ledger.reserve({
    runId: 'existing', videoId: 'video-a', estimatedMinutes: 100, limitMinutes: 120,
  })

  const result = await ledger.reserve({
    runId: 'confirmed',
    videoId: 'video-b',
    estimatedMinutes: 30,
    limitMinutes: 120,
    allowOverLimit: true,
  })

  assert.equal(result.accepted, true)
  assert.equal(result.rollingMinutes, 130)
})
