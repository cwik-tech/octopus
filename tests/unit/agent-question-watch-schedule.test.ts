import assert from 'node:assert/strict'
import test from 'node:test'

import { nextAgentQuestionRead } from '../../core/agent-question-watch-schedule.js'

const NOW = Date.parse('2026-09-20T12:00:00.000Z')

test('the first fruitless read is tried again a second later', () => {
  assert.deepEqual(nextAgentQuestionRead({ misses: 0, nowMs: NOW }), { misses: 1, dueAtMs: NOW + 1_000 })
})

test('each further fruitless read waits twice as long', () => {
  assert.deepEqual(nextAgentQuestionRead({ misses: 1, nowMs: NOW }), { misses: 2, dueAtMs: NOW + 2_000 })
  assert.deepEqual(nextAgentQuestionRead({ misses: 2, nowMs: NOW }), { misses: 3, dueAtMs: NOW + 4_000 })
  assert.deepEqual(nextAgentQuestionRead({ misses: 3, nowMs: NOW }), { misses: 4, dueAtMs: NOW + 8_000 })
})

test('the wait stops growing at a minute', () => {
  // 2^6 seconds is already past a minute, and it stays there.
  assert.equal(nextAgentQuestionRead({ misses: 6, nowMs: NOW }).dueAtMs, NOW + 60_000)
  assert.equal(nextAgentQuestionRead({ misses: 40, nowMs: NOW }).dueAtMs, NOW + 60_000)
})

test('a question nobody has answered is still due to be read again, however long it waits', () => {
  // A day of fruitless reads later, the answer is still expected: the schedule
  // always names a next read rather than giving up on the run.
  let schedule = { misses: 0, dueAtMs: NOW }
  for (let read = 0; read < 2_000; read += 1) {
    schedule = nextAgentQuestionRead({ misses: schedule.misses, nowMs: schedule.dueAtMs })
  }
  // Worked by hand: the first six waits are 1+2+4+8+16+32 seconds, 63,000 ms,
  // and the remaining 1,994 are a minute each, 119,640,000 ms.
  assert.equal(schedule.misses, 2_000)
  assert.equal(schedule.dueAtMs, NOW + 119_703_000)
})
