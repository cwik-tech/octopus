/**
 * Dock swim playback.
 *
 * Drives the Dock tile from the shared swim loop while the pointer sits inside
 * the Dock strip, and hands the tile back to the resting artwork the moment the
 * loop closes after the pointer leaves.
 *
 * The host is injected rather than imported so this file stays free of the
 * `electron` module and can be unit tested directly. `octopus-dock-icon.ts`
 * supplies the real screen and Dock.
 */
import {
  OCTOPUS_SWIM_AT_REST,
  OCTOPUS_SWIM_SETTINGS,
  advanceOctopusSwim,
  octopusSwimFrameIndex,
  type OctopusSwimPlaybackState,
  type OctopusSwimSettings,
} from '../contracts/octopus-swim.js'
import {
  isPointInsideDockStrip,
  resolveDockHoverStrip,
  type DockDisplayMetrics,
  type DockPoint,
} from './octopus-dock-geometry.js'

export interface DockSwimHost {
  getCursorPoint(): DockPoint
  getDisplayMetrics(point: DockPoint): DockDisplayMetrics
  showFrame(frameIndex: number): void
  showRestingIcon(): void
}

export interface DockSwimControllerOptions {
  readonly host: DockSwimHost
  readonly frameCount: number
  readonly settings?: OctopusSwimSettings
}

export interface DockSwimController {
  readonly state: OctopusSwimPlaybackState
  tick(elapsedSeconds: number): void
}

export function createDockSwimController(
  options: DockSwimControllerOptions,
): DockSwimController {
  const settings = options.settings ?? OCTOPUS_SWIM_SETTINGS
  const { host, frameCount } = options
  let state = OCTOPUS_SWIM_AT_REST
  let shownFrame: number | undefined

  return {
    get state(): OctopusSwimPlaybackState {
      return state
    },
    tick(elapsedSeconds: number): void {
      const point = host.getCursorPoint()
      const strip = resolveDockHoverStrip(host.getDisplayMetrics(point))
      const pointerOver = isPointInsideDockStrip(point, strip)

      const wasPlaying = state.playing
      state = advanceOctopusSwim(state, { elapsedSeconds, pointerOver, settings })

      if (!state.playing) {
        // Only reclaim the tile if this controller was the one animating it.
        if (wasPlaying) {
          shownFrame = undefined
          host.showRestingIcon()
        }
        return
      }

      const frameIndex = octopusSwimFrameIndex(state, frameCount)
      if (frameIndex === shownFrame) return
      shownFrame = frameIndex
      host.showFrame(frameIndex)
    },
  }
}
