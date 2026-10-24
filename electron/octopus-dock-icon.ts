/**
 * Wires the swim loop to the real macOS Dock tile.
 *
 * Frames are rendered on demand and cached, so the first pass over the Dock
 * pays for the frames it uses instead of stalling application launch. The timer
 * polls the cursor slowly while the icon rests and at the loop's frame rate
 * while it swims.
 */
import { app, nativeImage, screen, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'

import {
  OCTOPUS_SWIM_FRAMES_PER_SECOND,
  OCTOPUS_SWIM_SETTINGS,
  createOctopusSwimRenderer,
} from '../contracts/octopus-swim.js'
import { createDockSwimController } from './octopus-dock-swim.js'

/** 128pt at 2x, the largest tile macOS draws at full magnification. */
const DOCK_TILE_PIXELS = 256
const DOCK_TILE_SCALE_FACTOR = 2
const FRAME_INTERVAL_MS = Math.round(1000 / OCTOPUS_SWIM_FRAMES_PER_SECOND)
const RESTING_POLL_INTERVAL_MS = 150
/** A tick delayed past this (a sleeping machine, a busy main process) restarts the clock. */
const MAXIMUM_TICK_SECONDS = 0.25

export function startOctopusDockSwim(iconPath: string): () => void {
  const dock = app.dock
  if (process.platform !== 'darwin' || !dock) return () => {}
  if (!existsSync(iconPath)) {
    console.warn(`[octopus] no Dock animation: icon missing at ${iconPath}`)
    return () => {}
  }

  const resting = nativeImage.createFromPath(iconPath)
  if (resting.isEmpty()) {
    console.warn(`[octopus] no Dock animation: could not read ${iconPath}`)
    return () => {}
  }

  // Shrink first: the renderer resamples with a bilinear filter, which is a poor
  // way to reduce a 1254px icon on its own.
  const tile = resting.resize({
    width: DOCK_TILE_PIXELS,
    height: DOCK_TILE_PIXELS,
    quality: 'best',
  })
  const renderer = createOctopusSwimRenderer({
    source: tile.toBitmap(),
    sourceSize: DOCK_TILE_PIXELS,
    outputSize: DOCK_TILE_PIXELS,
    settings: OCTOPUS_SWIM_SETTINGS,
    // Raw bitmap pixels already carry alpha in the colour channels.
    sourceAlpha: 'premultiplied',
  })

  const cache = new Map<number, NativeImage>()
  function frameImage(frameIndex: number): NativeImage {
    const cached = cache.get(frameIndex)
    if (cached !== undefined) return cached
    const pixels = renderer.renderFrame(frameIndex)
    // createFromBuffer would try to decode PNG or JPEG first; createFromBitmap is
    // the documented counterpart to toBitmap().
    const image = nativeImage.createFromBitmap(Buffer.from(pixels.buffer), {
      width: DOCK_TILE_PIXELS,
      height: DOCK_TILE_PIXELS,
      scaleFactor: DOCK_TILE_SCALE_FACTOR,
    })
    cache.set(frameIndex, image)
    return image
  }

  const controller = createDockSwimController({
    frameCount: renderer.frameCount,
    settings: OCTOPUS_SWIM_SETTINGS,
    host: {
      getCursorPoint: () => screen.getCursorScreenPoint(),
      getDisplayMetrics: (point) => {
        const display = screen.getDisplayNearestPoint(point)
        return { bounds: display.bounds, workArea: display.workArea }
      },
      showFrame: (frameIndex) => dock.setIcon(frameImage(frameIndex)),
      showRestingIcon: () => dock.setIcon(resting),
    },
  })

  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let lastTickAt = Date.now()

  function schedule(): void {
    if (stopped) return
    const delay = controller.state.playing ? FRAME_INTERVAL_MS : RESTING_POLL_INTERVAL_MS
    timer = setTimeout(() => {
      const now = Date.now()
      const elapsedSeconds = Math.min((now - lastTickAt) / 1000, MAXIMUM_TICK_SECONDS)
      lastTickAt = now
      try {
        controller.tick(elapsedSeconds)
      } catch (error) {
        // A cosmetic animation must never take the main process down with it.
        console.error(error instanceof Error ? error.stack ?? error.message : String(error))
        stopped = true
        return
      }
      schedule()
    }, delay)
  }

  schedule()

  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    dock.setIcon(resting)
  }
}
