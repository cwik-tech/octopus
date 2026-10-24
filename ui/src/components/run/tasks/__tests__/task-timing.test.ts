import { describe, expect, it } from 'vitest'

import {
  formatElapsedDuration,
  getElapsedDurationMs,
  parseFirstTimestamp,
} from '../task-timing'

describe('parseFirstTimestamp', () => {
  it('prefers execution start time over worker and creation timestamps', () => {
    expect(
      parseFirstTimestamp(
        '2026-07-10T12:00:05.000Z',
        '2026-07-10T12:00:03.000Z',
        '2026-07-10T12:00:00.000Z',
      ),
    ).toBe(new Date('2026-07-10T12:00:05.000Z').getTime())
  })

  it('falls back to the next valid timestamp', () => {
    expect(
      parseFirstTimestamp('not-a-date', undefined, '2026-07-10T12:00:00.000Z'),
    ).toBe(new Date('2026-07-10T12:00:00.000Z').getTime())
  })
})

describe('getElapsedDurationMs', () => {
  it('counts from task execution start while the task is running', () => {
    expect(
      getElapsedDurationMs({
        mode: 'running',
        startedAt: 1_000,
        now: 6_250,
      }),
    ).toBe(5_250)
  })

  // Waiting on a decision is not finishing, so this mode is not terminal: the
  // elapsed time is measured to the supplied `now` rather than frozen at a
  // completion timestamp. What the views do with that is their own business,
  // covered in `task-strip.test.tsx` and `task-run-summary.test.tsx`, which
  // prove both tickers keep running while a model choice is pending.
  it('measures to now rather than freezing while a task waits on a model choice', () => {
    expect(
      getElapsedDurationMs({
        mode: 'awaiting_model_choice',
        startedAt: 1_000,
        completedAt: 2_000,
        now: 6_250,
      }),
    ).toBe(5_250)
  })

  it('uses persisted completion time for all terminal task modes', () => {
    for (const mode of ['interrupted', 'done', 'error', 'blocked', 'cancelled'] as const) {
      expect(
        getElapsedDurationMs({
          mode,
          startedAt: 1_000,
          completedAt: 9_000,
          now: 50_000,
        }),
      ).toBe(8_000)
    }
  })

  it('does not show a duration before an execution start is available', () => {
    expect(getElapsedDurationMs({ mode: 'running', now: 10_000 })).toBeNull()
  })

  it('does not show execution time while a task is queued', () => {
    expect(
      getElapsedDurationMs({
        mode: 'queued',
        startedAt: 1_000,
        now: 10_000,
      }),
    ).toBeNull()
  })

  it('does not produce a negative duration when timestamps arrive out of order', () => {
    expect(
      getElapsedDurationMs({
        mode: 'done',
        startedAt: 9_000,
        completedAt: 1_000,
        now: 10_000,
      }),
    ).toBe(0)
  })
})

describe('formatElapsedDuration', () => {
  it('formats minutes and seconds below an hour', () => {
    expect(formatElapsedDuration(5 * 60_000 + 7_000)).toBe('05:07')
  })

  it('includes hours for longer work', () => {
    expect(formatElapsedDuration(3_723_000)).toBe('1:02:03')
  })
})
