/**
 * Octopus swim animation.
 *
 * Contract: the app icon animates as a closed loop that can start and stop on
 * pointer hover. Frame zero is the untouched icon, so a stopped animation is
 * indistinguishable from the shipped artwork. No frame-to-frame step stands out
 * from the rest, so the loop neither stalls nor snaps as it crosses the seam.
 * The tentacles carry most of the motion, and the warp never pushes artwork off
 * the edge of the tile.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OCTOPUS_SWIM_AT_REST,
  OCTOPUS_SWIM_FRAMES_PER_SECOND,
  OCTOPUS_SWIM_SETTINGS,
  advanceOctopusSwim,
  createOctopusSwimRenderer,
  octopusSwimFrameCount,
  octopusSwimFrameIndex,
  renderOctopusSwimFrame,
  type OctopusSwimSettings,
} from '../../contracts/octopus-swim.js'

/** A stand-in icon: a solid head over striped tentacles, on transparency. */
function makeSourceIcon(size: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(size * size * 4)
  const centre = (size - 1) / 2
  const stripe = Math.max(1, Math.round(size / 10))
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inHead = Math.hypot(x - centre, y - size * 0.3) < size * 0.22
      const inTentacles =
        x > size * 0.05 &&
        x < size * 0.95 &&
        y > size * 0.45 &&
        y < size * 0.95 &&
        Math.floor(x / stripe) % 2 === 0
      const offset = (y * size + x) * 4
      const solid = inHead || inTentacles
      pixels[offset] = solid ? 140 + ((x * 7) % 90) : 0
      pixels[offset + 1] = solid ? 70 : 0
      pixels[offset + 2] = solid ? 210 : 0
      pixels[offset + 3] = solid ? 255 : 0
    }
  }
  return pixels
}

function at(pixels: Uint8ClampedArray, offset: number): number {
  return pixels[offset] ?? 0
}

function maxChannelDifference(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  let largest = 0
  for (let index = 0; index < left.length; index += 1) {
    const difference = Math.abs(at(left, index) - at(right, index))
    if (difference > largest) largest = difference
  }
  return largest
}

function totalDifference(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  let total = 0
  for (let offset = 0; offset < left.length; offset += 4) {
    const leftAlpha = at(left, offset + 3) / 255
    const rightAlpha = at(right, offset + 3) / 255
    for (let channel = 0; channel < 3; channel += 1) {
      total += Math.abs(
        at(left, offset + channel) * leftAlpha -
          at(right, offset + channel) * rightAlpha,
      )
    }
    total += Math.abs(at(left, offset + 3) - at(right, offset + 3))
  }
  return total
}

function bandDifference(
  left: Uint8ClampedArray,
  right: Uint8ClampedArray,
  size: number,
  firstRow: number,
  lastRow: number,
): number {
  let total = 0
  for (let y = firstRow; y < lastRow; y += 1) {
    for (let index = y * size * 4; index < (y + 1) * size * 4; index += 1) {
      total += Math.abs(at(left, index) - at(right, index))
    }
  }
  return total
}

function renderLoop(size: number, settings: OctopusSwimSettings): Uint8ClampedArray[] {
  const source = makeSourceIcon(size)
  const frameCount = octopusSwimFrameCount(settings)
  return Array.from({ length: frameCount }, (_unused, frameIndex) =>
    renderOctopusSwimFrame({
      source,
      sourceSize: size,
      outputSize: size,
      frameIndex,
      frameCount,
      settings,
    }),
  )
}

function frameAt(frames: readonly Uint8ClampedArray[], index: number): Uint8ClampedArray {
  const frame = frames[index]
  if (frame === undefined) throw new Error(`missing frame ${index}`)
  return frame
}

test('the production resting frame preserves the source icon at full size', () => {
  const size = 48
  const source = makeSourceIcon(size)

  const resting = renderOctopusSwimFrame({
    source,
    sourceSize: size,
    outputSize: size,
    frameIndex: 0,
    frameCount: octopusSwimFrameCount(OCTOPUS_SWIM_SETTINGS),
    settings: OCTOPUS_SWIM_SETTINGS,
  })

  assert.equal(maxChannelDifference(resting, source), 0)
})

test('the frame count follows the loop length at twenty frames per second', () => {
  assert.equal(OCTOPUS_SWIM_FRAMES_PER_SECOND, 20)
  assert.equal(octopusSwimFrameCount({ ...OCTOPUS_SWIM_SETTINGS, loopSeconds: 3.1 }), 62)
  assert.equal(octopusSwimFrameCount({ ...OCTOPUS_SWIM_SETTINGS, loopSeconds: 1 }), 20)
})

test('no step in the loop stands out, so the seam neither stalls nor snaps', () => {
  const size = 64
  const frames = renderLoop(size, OCTOPUS_SWIM_SETTINGS)

  const steps = frames.map((frame, index) =>
    totalDifference(frame, frameAt(frames, (index + 1) % frames.length)),
  )
  const ordered = [...steps].sort((left, right) => left - right)
  const median = ordered[Math.floor(ordered.length / 2)] ?? 0
  const largest = ordered[ordered.length - 1] ?? 0
  const smallest = ordered[0] ?? 0
  const largestIndex = steps.indexOf(largest)

  assert.ok(smallest > 0, 'every frame should differ from the next')
  assert.ok(
    largest <= median * 2,
    `largest step ${largest} at frame ${largestIndex} should stay within twice the median step ${median}`,
  )
})

test('the tentacles carry more of the motion than the head', () => {
  const size = 64
  const settings = { ...OCTOPUS_SWIM_SETTINGS, paddingRatio: 0 }
  const frames = renderLoop(size, settings)
  const quarterTurn = frameAt(frames, Math.floor(frames.length / 4))
  const resting = frameAt(frames, 0)

  const band = Math.round(size * 0.3)
  const headMotion = bandDifference(resting, quarterTurn, size, 0, band)
  const tentacleMotion = bandDifference(resting, quarterTurn, size, size - band, size)

  assert.ok(
    tentacleMotion > headMotion * 3,
    `tentacle motion ${tentacleMotion} should dominate head motion ${headMotion}`,
  )
})

test('the warp keeps the artwork clear of the tile edge', () => {
  const size = 64
  const frames = renderLoop(size, { ...OCTOPUS_SWIM_SETTINGS, paddingRatio: 0.1 })

  for (const [index, frame] of frames.entries()) {
    let opaquePixels = 0
    for (let offset = 3; offset < frame.length; offset += 4) {
      if (at(frame, offset) > 0) opaquePixels += 1
    }
    assert.ok(opaquePixels > size, `frame ${index} should actually contain artwork`)

    for (let step = 0; step < size; step += 1) {
      const edges = [
        at(frame, (0 * size + step) * 4 + 3),
        at(frame, ((size - 1) * size + step) * 4 + 3),
        at(frame, (step * size + 0) * 4 + 3),
        at(frame, (step * size + size - 1) * 4 + 3),
      ]
      assert.equal(Math.max(...edges), 0, `frame ${index} touches the tile edge at ${step}`)
    }
  }
})

test('playback advances while the pointer rests on the icon', () => {
  const state = advanceOctopusSwim(OCTOPUS_SWIM_AT_REST, {
    elapsedSeconds: 0.62,
    pointerOver: true,
    settings: OCTOPUS_SWIM_SETTINGS,
  })

  assert.equal(state.playing, true)
  assert.ok(Math.abs(state.phase - 0.2) < 1e-9, `phase ${state.phase} should be a fifth of a loop`)
})

test('playback finishes the loop at double speed once the pointer leaves, then rests', () => {
  const hovered = advanceOctopusSwim(OCTOPUS_SWIM_AT_REST, {
    elapsedSeconds: 0.62,
    pointerOver: true,
    settings: OCTOPUS_SWIM_SETTINGS,
  })

  const settling = advanceOctopusSwim(hovered, {
    elapsedSeconds: 0.62,
    pointerOver: false,
    settings: OCTOPUS_SWIM_SETTINGS,
  })
  assert.equal(settling.playing, true)
  assert.ok(Math.abs(settling.phase - 0.6) < 1e-9, `phase ${settling.phase} should advance twice as fast`)

  const rested = advanceOctopusSwim(settling, {
    elapsedSeconds: 5,
    pointerOver: false,
    settings: OCTOPUS_SWIM_SETTINGS,
  })
  assert.deepEqual(rested, OCTOPUS_SWIM_AT_REST)
  assert.equal(octopusSwimFrameIndex(rested, 62), 0)
})

test('a pointer returning mid-settle keeps the loop running instead of restarting it', () => {
  const settling = advanceOctopusSwim(
    { playing: true, phase: 0.4 },
    { elapsedSeconds: 0.31, pointerOver: false, settings: OCTOPUS_SWIM_SETTINGS },
  )

  const resumed = advanceOctopusSwim(settling, {
    elapsedSeconds: 0.31,
    pointerOver: true,
    settings: OCTOPUS_SWIM_SETTINGS,
  })

  assert.equal(resumed.playing, true)
  assert.ok(resumed.phase > settling.phase, 'the loop should continue from where it was')
})

test('the reusable renderer produces the same frames as the single-frame helper', () => {
  const size = 40
  const source = makeSourceIcon(size)
  const frameCount = octopusSwimFrameCount(OCTOPUS_SWIM_SETTINGS)
  const renderer = createOctopusSwimRenderer({
    source,
    sourceSize: size,
    outputSize: size,
    settings: OCTOPUS_SWIM_SETTINGS,
  })

  assert.equal(renderer.frameCount, frameCount)
  for (const frameIndex of [0, 7, frameCount - 1]) {
    const expected = renderOctopusSwimFrame({
      source,
      sourceSize: size,
      outputSize: size,
      frameIndex,
      frameCount,
      settings: OCTOPUS_SWIM_SETTINGS,
    })
    assert.equal(maxChannelDifference(renderer.renderFrame(frameIndex), expected), 0)
  }
})

test('a premultiplied source is resampled and returned in the same premultiplied form', () => {
  // Electron hands back raw bitmap pixels that already carry alpha in the colour
  // channels. Premultiplying those a second time darkens every antialiased edge.
  const size = 48
  const straight = makeSourceIcon(size)
  const premultiplied = new Uint8ClampedArray(straight.length)
  for (let pixel = 0; pixel < size * size; pixel += 1) {
    const offset = pixel * 4
    const alpha = straight[offset + 3] ?? 0
    for (let channel = 0; channel < 3; channel += 1) {
      premultiplied[offset + channel] = ((straight[offset + channel] ?? 0) * alpha) / 255
    }
    premultiplied[offset + 3] = alpha
  }

  const renderer = createOctopusSwimRenderer({
    source: premultiplied,
    sourceSize: size,
    outputSize: size,
    settings: { ...OCTOPUS_SWIM_SETTINGS, paddingRatio: 0 },
    sourceAlpha: 'premultiplied',
  })

  assert.equal(maxChannelDifference(renderer.renderFrame(0), premultiplied), 0)
})

test('a half-transparent premultiplied pixel keeps its colour instead of darkening', () => {
  const size = 8
  const source = new Uint8ClampedArray(size * size * 4)
  for (let pixel = 0; pixel < size * size; pixel += 1) {
    const offset = pixel * 4
    source[offset] = 64 // a colour already multiplied by an alpha of 128/255
    source[offset + 1] = 32
    source[offset + 2] = 96
    source[offset + 3] = 128
  }

  const renderer = createOctopusSwimRenderer({
    source,
    sourceSize: size,
    outputSize: size,
    settings: { ...OCTOPUS_SWIM_SETTINGS, paddingRatio: 0 },
    sourceAlpha: 'premultiplied',
  })
  const resting = renderer.renderFrame(0)

  assert.equal(resting[0], 64)
  assert.equal(resting[1], 32)
  assert.equal(resting[2], 96)
  assert.equal(resting[3], 128)
})
