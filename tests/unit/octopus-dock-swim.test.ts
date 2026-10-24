/**
 * Dock swim playback.
 *
 * Contract: while the pointer is inside the Dock strip the Dock tile cycles
 * through the swim frames. When the pointer leaves, the loop plays out and the
 * tile is handed back to the resting artwork exactly once, so a stopped
 * animation leaves the Dock showing the shipped icon. A pointer that never
 * enters the strip never touches the Dock tile at all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { OCTOPUS_SWIM_SETTINGS, octopusSwimFrameCount } from '../../contracts/octopus-swim.js'
import { createDockSwimController } from '../../electron/octopus-dock-swim.js'
import type { DockDisplayMetrics, DockPoint } from '../../electron/octopus-dock-geometry.js'

const DISPLAY: DockDisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 876 },
}
const INSIDE_THE_STRIP: DockPoint = { x: 700, y: 950 }
const ABOVE_THE_STRIP: DockPoint = { x: 700, y: 400 }

interface Recorder {
  readonly shownFrames: number[]
  readonly restingCalls: number[]
}

function makeController(cursor: { point: DockPoint }) {
  const recorder: Recorder = { shownFrames: [], restingCalls: [] }
  const controller = createDockSwimController({
    frameCount: octopusSwimFrameCount(OCTOPUS_SWIM_SETTINGS),
    settings: OCTOPUS_SWIM_SETTINGS,
    host: {
      getCursorPoint: () => cursor.point,
      getDisplayMetrics: () => DISPLAY,
      showFrame: (frameIndex) => recorder.shownFrames.push(frameIndex),
      showRestingIcon: () => recorder.restingCalls.push(recorder.shownFrames.length),
    },
  })
  return { controller, recorder }
}

test('the Dock tile cycles through frames while the cursor is inside the strip', () => {
  const cursor = { point: INSIDE_THE_STRIP }
  const { controller, recorder } = makeController(cursor)

  for (let step = 0; step < 10; step += 1) controller.tick(0.05)

  assert.ok(recorder.shownFrames.length >= 5, `expected several frames, saw ${recorder.shownFrames.length}`)
  assert.deepEqual(
    [...recorder.shownFrames].sort((left, right) => left - right),
    recorder.shownFrames,
    'frames should advance in order',
  )
  assert.equal(recorder.restingCalls.length, 0)
})

test('the Dock tile returns to the resting artwork once after the cursor leaves', () => {
  const cursor = { point: INSIDE_THE_STRIP }
  const { controller, recorder } = makeController(cursor)

  controller.tick(0.5)
  cursor.point = ABOVE_THE_STRIP
  for (let step = 0; step < 200; step += 1) controller.tick(0.05)

  assert.equal(recorder.restingCalls.length, 1, 'the resting icon should be restored exactly once')
  const framesAfterResting = recorder.shownFrames.length - (recorder.restingCalls[0] ?? 0)
  assert.equal(framesAfterResting, 0, 'no frame should be pushed after the tile is handed back')
})

test('a cursor that never enters the strip never touches the Dock tile', () => {
  const cursor = { point: ABOVE_THE_STRIP }
  const { controller, recorder } = makeController(cursor)

  for (let step = 0; step < 50; step += 1) controller.tick(0.05)

  assert.equal(recorder.shownFrames.length, 0)
  assert.equal(recorder.restingCalls.length, 0)
})

test('a repeated frame is not pushed to the Dock twice', () => {
  const cursor = { point: INSIDE_THE_STRIP }
  const { controller, recorder } = makeController(cursor)

  for (let step = 0; step < 20; step += 1) controller.tick(0.001)

  const unique = new Set(recorder.shownFrames)
  assert.equal(unique.size, recorder.shownFrames.length, 'each frame should be pushed at most once')
})
