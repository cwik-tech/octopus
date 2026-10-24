/**
 * Dock hover geometry for the octopus swim animation.
 *
 * Contract: macOS never tells an application that the pointer is over its own
 * Dock tile, so the trigger is "the pointer is inside the Dock strip". The
 * strip is derived from the gap between a display's full bounds and its work
 * area, which needs no accessibility permission. An auto-hidden Dock leaves no
 * gap, so a thin band along the Dock's screen edge stands in for it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HIDDEN_DOCK_BAND_POINTS,
  isPointInsideDockStrip,
  resolveDockHoverStrip,
} from '../../electron/octopus-dock-geometry.js'

const FULL_SCREEN = { x: 0, y: 0, width: 1512, height: 982 } as const
const MENU_BAR_HEIGHT = 38

test('a Dock along the bottom becomes a strip across the bottom of the display', () => {
  const strip = resolveDockHoverStrip({
    bounds: FULL_SCREEN,
    workArea: { x: 0, y: MENU_BAR_HEIGHT, width: 1512, height: 876 },
  })

  assert.deepEqual(strip, { x: 0, y: 914, width: 1512, height: 68 })
})

test('a Dock along the left becomes a strip down the left edge', () => {
  const strip = resolveDockHoverStrip({
    bounds: FULL_SCREEN,
    workArea: { x: 80, y: MENU_BAR_HEIGHT, width: 1432, height: 944 },
  })

  assert.deepEqual(strip, { x: 0, y: 38, width: 80, height: 944 })
})

test('a Dock along the right becomes a strip down the right edge', () => {
  const strip = resolveDockHoverStrip({
    bounds: FULL_SCREEN,
    workArea: { x: 0, y: MENU_BAR_HEIGHT, width: 1432, height: 944 },
  })

  assert.deepEqual(strip, { x: 1432, y: 38, width: 80, height: 944 })
})

test('an auto-hidden Dock still leaves a thin band along the bottom edge', () => {
  const strip = resolveDockHoverStrip({
    bounds: FULL_SCREEN,
    workArea: { x: 0, y: MENU_BAR_HEIGHT, width: 1512, height: 944 },
  })

  assert.deepEqual(strip, {
    x: 0,
    y: 982 - HIDDEN_DOCK_BAND_POINTS,
    width: 1512,
    height: HIDDEN_DOCK_BAND_POINTS,
  })
})

test('the widest gap wins when a display is inset on more than one edge', () => {
  const strip = resolveDockHoverStrip({
    bounds: FULL_SCREEN,
    workArea: { x: 20, y: MENU_BAR_HEIGHT, width: 1492, height: 876 },
  })

  assert.deepEqual(strip, { x: 0, y: 914, width: 1512, height: 68 })
})

test('a point counts as hovering only inside the strip', () => {
  const strip = { x: 0, y: 914, width: 1512, height: 68 }

  assert.equal(isPointInsideDockStrip({ x: 700, y: 950 }, strip), true)
  assert.equal(isPointInsideDockStrip({ x: 700, y: 914 }, strip), true)
  assert.equal(isPointInsideDockStrip({ x: 700, y: 913 }, strip), false)
  assert.equal(isPointInsideDockStrip({ x: 1512, y: 950 }, strip), false)
  assert.equal(isPointInsideDockStrip({ x: -1, y: 950 }, strip), false)
})
