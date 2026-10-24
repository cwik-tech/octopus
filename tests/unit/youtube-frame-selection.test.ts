import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildYoutubeFrameSchedule,
  deduplicateYoutubeFrames,
  selectBestYoutubeFrameCandidate,
} from '../../domains/youtube/youtube-frame-selection.js'

test('required cues are inserted before supporting work without exceeding the decode cap', () => {
  const schedule = buildYoutubeFrameSchedule({
    durationSeconds: 3_600,
    maximumFrames: 5,
    denseIntervalSeconds: 5,
    steps: [
      {
        id: 'first',
        startSeconds: 0,
        endSeconds: 1_800,
        visualCues: [{ timestampSeconds: 1_790, importance: 'required' }],
      },
      {
        id: 'second',
        startSeconds: 1_801,
        endSeconds: 3_600,
        visualCues: [{ timestampSeconds: 3_590, importance: 'required' }],
      },
    ],
  })

  assert.ok(schedule.length <= 5)
  assert.ok(schedule.filter((candidate) => candidate.requiredCueId === 'first:1790').length >= 1)
  assert.ok(schedule.filter((candidate) => candidate.requiredCueId === 'second:3590').length >= 1)
  assert.equal(schedule.some((candidate) => candidate.requestedTimestampSeconds === 1_790), true)
  assert.equal(schedule.some((candidate) => candidate.requestedTimestampSeconds === 3_590), true)
  assert.ok(schedule.filter((candidate) => !candidate.requiredCueId).length <= 1)
})

test('frame schedules clamp required brackets to valid video timestamps', () => {
  const schedule = buildYoutubeFrameSchedule({
    durationSeconds: 10,
    maximumFrames: 1,
    steps: [{
      id: 'edge',
      startSeconds: 0,
      endSeconds: 10,
      visualCues: [{ timestampSeconds: 0, importance: 'required' }],
    }],
  })

  assert.deepEqual(schedule.map((candidate) => candidate.timestampSeconds), [0])
})

test('a one-hour dense schedule spans the instructional range and remains bounded', () => {
  const schedule = buildYoutubeFrameSchedule({
    durationSeconds: 3_600,
    maximumFrames: 150,
    denseIntervalSeconds: 5,
    steps: [{ id: 'lecture', startSeconds: 0, endSeconds: 3_600,
      visualCues: [{ timestampSeconds: 1_800, importance: 'required' }] }],
  })
  assert.equal(schedule.length, 150)
  assert.equal(schedule.some((candidate) => candidate.timestampSeconds < 30), true)
  assert.equal(schedule.some((candidate) => candidate.timestampSeconds > 3_570), true)
  assert.equal(schedule.some((candidate) => candidate.requestedTimestampSeconds === 1_800), true)
})

test('frame quality selection avoids a low-information exact frame when a nearby frame is richer', () => {
  const selected = selectBestYoutubeFrameCandidate(10, [
    { actualTimestampSeconds: 9.5, byteLength: 120_000, meanLuma: 120, lumaRange: 150, blurScore: 1, valid: true },
    { actualTimestampSeconds: 10, byteLength: 2_000, meanLuma: 1, lumaRange: 1, blurScore: 20, valid: false },
    { actualTimestampSeconds: 10.5, byteLength: 90_000, meanLuma: 120, lumaRange: 100, blurScore: 8, valid: true },
  ])

  assert.equal(selected?.actualTimestampSeconds, 9.5)
})

test('frame quality rejects near-black candidates and prefers sharper visible evidence', () => {
  const selected = selectBestYoutubeFrameCandidate(10, [
    { actualTimestampSeconds: 10, byteLength: 200_000, meanLuma: 2, lumaRange: 1, blurScore: 1, valid: false },
    { actualTimestampSeconds: 9.9, byteLength: 10_000, meanLuma: 100, lumaRange: 120, blurScore: 2, valid: true },
    { actualTimestampSeconds: 10.1, byteLength: 500_000, meanLuma: 100, lumaRange: 120, blurScore: 20, valid: true },
  ])
  assert.equal(selected?.actualTimestampSeconds, 9.9)
})

test('deduplication pins required frames and removes equivalent supporting frames', () => {
  const frames = deduplicateYoutubeFrames([
    { stepId: 'required', importance: 'required', requestedTimestampSeconds: 1,
      actualTimestampSeconds: 1, relativePath: 'frames/required.png', caption: 'Required',
      altText: 'Required state', selectionReason: 'required', sha256: 'same',
      meanLuma: 100, lumaRange: 90, blurScore: 2 },
    { stepId: 'supporting', importance: 'supporting', requestedTimestampSeconds: 2,
      actualTimestampSeconds: 2, relativePath: 'frames/supporting.png', caption: 'Supporting',
      altText: 'Supporting state', selectionReason: 'supporting', sha256: 'same',
      meanLuma: 100, lumaRange: 90, blurScore: 2 },
  ])
  assert.deepEqual(frames.map((frame) => frame.stepId), ['required'])
})

test('deduplication removes perceptually equivalent supporting frames with different PNG hashes', () => {
  const frames = deduplicateYoutubeFrames([
    { stepId: 'required', importance: 'required', requestedTimestampSeconds: 1,
      actualTimestampSeconds: 1, relativePath: 'frames/required.png', caption: 'Required',
      altText: 'Required state', selectionReason: 'required', sha256: 'png-a',
      visualHash: '0000000000000000' },
    { stepId: 'supporting', importance: 'supporting', requestedTimestampSeconds: 2,
      actualTimestampSeconds: 2, relativePath: 'frames/supporting.png', caption: 'Supporting',
      altText: 'Supporting state', selectionReason: 'supporting', sha256: 'png-b',
      visualHash: '0000000000000001' },
  ])
  assert.deepEqual(frames.map((frame) => frame.stepId), ['required'])
})

test('deduplication preserves adjacent required cues even when they decode to one visual frame', () => {
  const frames = deduplicateYoutubeFrames([
    { stepId: 'first-required', importance: 'required', requestedTimestampSeconds: 1,
      actualTimestampSeconds: 1, relativePath: 'frames/first.png', caption: 'First action',
      altText: 'First required action', selectionReason: 'required', sha256: 'same-keyframe' },
    { stepId: 'second-required', importance: 'required', requestedTimestampSeconds: 1.1,
      actualTimestampSeconds: 1, relativePath: 'frames/second.png', caption: 'Second action',
      altText: 'Second required action', selectionReason: 'required', sha256: 'same-keyframe' },
  ])

  assert.deepEqual(frames.map((frame) => frame.stepId), ['first-required', 'second-required'])
})
