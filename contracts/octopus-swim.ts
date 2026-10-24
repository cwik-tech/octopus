/**
 * Octopus swim animation: a closed, hover-triggered loop for the app icon.
 *
 * The artwork is never redrawn. Each frame is the shipped icon resampled
 * through a displacement field, so the Dock tile animates without replacing
 * the shipped artwork.
 *
 * Two properties make the loop usable as an icon. Every term is periodic in the
 * loop position, and every term is zero at position zero, so frame zero is the
 * untouched icon and the step from the last frame back to frame zero carries the
 * same velocity as any other step. The animation can therefore start and stop on
 * frame zero without a visible jump, and it never stalls at the seam.
 */

export interface OctopusSwimSettings {
  /** Horizontal tentacle sweep, as a percentage of the tile. */
  readonly swayPercent: number
  /** Radians of travelling wave from the top of the tile to the bottom. */
  readonly waveDown: number
  /** Radians of phase between the left and right edges, so the sides counter-sway. */
  readonly leftRightSplit: number
  /** Vertical lift of the outermost tentacles, as a percentage of the tile. */
  readonly outerTipLiftPercent: number
  /** Squash and stretch of the head, as a percentage of the tile. */
  readonly headPulsePercent: number
  /** Vertical drift of the whole body, as a percentage of the tile. */
  readonly bodyBobPercent: number
  /** Seconds for one full loop. */
  readonly loopSeconds: number
  /** Share of the tile left empty around the icon, so the warp cannot clip. */
  readonly paddingRatio: number
}

/**
 * Tuned by eye against the real icon in a retired HTML playground
 * (`git show babda906^:docs/2026-08-22-Octopus-Swim-Animation.html`). These
 * values are the contract; the playground is only how they were chosen.
 */
export const OCTOPUS_SWIM_SETTINGS: OctopusSwimSettings = {
  swayPercent: 4,
  waveDown: 1,
  leftRightSplit: 1.5,
  outerTipLiftPercent: 5,
  headPulsePercent: 1,
  bodyBobPercent: 1.1,
  loopSeconds: 3.1,
  paddingRatio: 0,
}

/**
 * The Dock repaints through inter-process messages, which caps a Dock tile at
 * roughly twenty updates per second. Both surfaces use that rate so the two
 * animations stay in step.
 */
export const OCTOPUS_SWIM_FRAMES_PER_SECOND = 20

/** How much faster the loop plays out once the pointer leaves. */
export const OCTOPUS_SWIM_SETTLE_RATE = 2

/** Vertical companion to the horizontal sweep, which gives each tentacle a curl. */
const DRIFT_PERCENT = 1.6
/** Quarter-turn offset between the horizontal and vertical components of the curl. */
const CURL_RADIANS = 1.2
/** The head holds still and the tips move most: where that transition happens. */
const TENTACLE_RAMP_START = 0.26
const TENTACLE_RAMP_END = 0.94
/** Vertical band over which the outermost tentacles take their lift. */
const OUTER_LIFT_START = 0.12
const OUTER_LIFT_FULL = 0.46
const OUTER_LIFT_FADE_START = 0.6
const OUTER_LIFT_FADE_AMOUNT = 0.45
/** Vertical band over which the head stops being the head. */
const HEAD_START = 0.2
const HEAD_END = 0.55
/** The head pivots about this height, so the crown moves and the base does not. */
const HEAD_PIVOT = 0.45
/** Motion fades at an unpadded tile's edge so full-size artwork cannot clip. */
const UNPADDED_EDGE_GUARD_RATIO = 0.1
/** Below this accumulated alpha a sample is treated as empty rather than resampled. */
const MINIMUM_SAMPLE_ALPHA = 0.4

export interface OctopusSwimPlaybackState {
  readonly playing: boolean
  /** Position within the loop, from zero up to but not including one. */
  readonly phase: number
}

export const OCTOPUS_SWIM_AT_REST: OctopusSwimPlaybackState = { playing: false, phase: 0 }

export interface OctopusSwimFrameRequest {
  /** Square RGBA or BGRA pixels. Only the alpha channel's position matters. */
  readonly source: Uint8Array | Uint8ClampedArray
  readonly sourceSize: number
  readonly outputSize: number
  readonly frameIndex: number
  readonly frameCount: number
  readonly settings: OctopusSwimSettings
}

export interface OctopusSwimAdvance {
  readonly elapsedSeconds: number
  readonly pointerOver: boolean
  readonly settings: OctopusSwimSettings
}

export function octopusSwimFrameCount(settings: OctopusSwimSettings): number {
  return Math.max(1, Math.round(settings.loopSeconds * OCTOPUS_SWIM_FRAMES_PER_SECOND))
}

export function octopusSwimFrameIndex(
  state: OctopusSwimPlaybackState,
  frameCount: number,
): number {
  if (!state.playing || frameCount <= 0) return 0
  const index = Math.floor(state.phase * frameCount)
  return ((index % frameCount) + frameCount) % frameCount
}

/**
 * Moves playback forward. While the pointer is over the icon the loop runs at
 * its natural rate. Once the pointer leaves, the loop plays out at
 * `OCTOPUS_SWIM_SETTLE_RATE` and stops the moment it reaches frame zero, which
 * is the resting icon, so the animation never freezes mid-stroke.
 */
export function advanceOctopusSwim(
  state: OctopusSwimPlaybackState,
  advance: OctopusSwimAdvance,
): OctopusSwimPlaybackState {
  const { elapsedSeconds, pointerOver, settings } = advance
  if (!state.playing && !pointerOver) return OCTOPUS_SWIM_AT_REST
  if (settings.loopSeconds <= 0) return OCTOPUS_SWIM_AT_REST

  const rate = pointerOver ? 1 : OCTOPUS_SWIM_SETTLE_RATE
  const phase = state.phase + (elapsedSeconds / settings.loopSeconds) * rate
  if (phase >= 1 && !pointerOver) return OCTOPUS_SWIM_AT_REST
  return { playing: true, phase: phase - Math.floor(phase) }
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function readChannel(pixels: Uint8Array | Uint8ClampedArray | Float32Array, index: number): number {
  return pixels[index] ?? 0
}

/**
 * How the source carries alpha. A canvas hands back straight colour, which has
 * to be premultiplied before resampling so the bilinear filter does not mix the
 * colour of transparent pixels into the icon's outline. Electron's raw bitmap
 * already carries alpha in the colour channels; premultiplying that a second
 * time darkens every antialiased edge.
 */
export type OctopusSwimSourceAlpha = 'straight' | 'premultiplied'

function premultiply(
  source: Uint8Array | Uint8ClampedArray,
  size: number,
  sourceAlpha: OctopusSwimSourceAlpha,
): Float32Array {
  const premultiplied = new Float32Array(size * size * 4)
  for (let pixel = 0; pixel < size * size; pixel += 1) {
    const offset = pixel * 4
    const alpha = readChannel(source, offset + 3)
    const scale = sourceAlpha === 'premultiplied' ? 1 : alpha / 255
    premultiplied[offset] = readChannel(source, offset) * scale
    premultiplied[offset + 1] = readChannel(source, offset + 1) * scale
    premultiplied[offset + 2] = readChannel(source, offset + 2) * scale
    premultiplied[offset + 3] = alpha
  }
  return premultiplied
}

function sampleInto(
  premultiplied: Float32Array,
  size: number,
  sourceX: number,
  sourceY: number,
  output: Uint8ClampedArray,
  target: number,
  restoreStraightAlpha: boolean,
): void {
  if (sourceX < 0 || sourceY < 0 || sourceX > size - 1 || sourceY > size - 1) return

  const left = Math.floor(sourceX)
  const top = Math.floor(sourceY)
  const right = Math.min(left + 1, size - 1)
  const bottom = Math.min(top + 1, size - 1)
  const fractionX = sourceX - left
  const fractionY = sourceY - top

  const topLeft = (1 - fractionX) * (1 - fractionY)
  const topRight = fractionX * (1 - fractionY)
  const bottomLeft = (1 - fractionX) * fractionY
  const bottomRight = fractionX * fractionY

  const a = (top * size + left) * 4
  const b = (top * size + right) * 4
  const c = (bottom * size + left) * 4
  const d = (bottom * size + right) * 4

  const alpha =
    readChannel(premultiplied, a + 3) * topLeft +
    readChannel(premultiplied, b + 3) * topRight +
    readChannel(premultiplied, c + 3) * bottomLeft +
    readChannel(premultiplied, d + 3) * bottomRight
  if (alpha < MINIMUM_SAMPLE_ALPHA) return

  const restore = restoreStraightAlpha ? 255 / alpha : 1
  for (let channel = 0; channel < 3; channel += 1) {
    output[target + channel] =
      (readChannel(premultiplied, a + channel) * topLeft +
        readChannel(premultiplied, b + channel) * topRight +
        readChannel(premultiplied, c + channel) * bottomLeft +
        readChannel(premultiplied, d + channel) * bottomRight) *
      restore
  }
  output[target + 3] = alpha
}

export interface OctopusSwimRenderer {
  readonly frameCount: number
  readonly outputSize: number
  renderFrame(frameIndex: number): Uint8ClampedArray
}

export interface OctopusSwimRendererOptions {
  /** Square RGBA or BGRA pixels. Only the alpha channel's position matters. */
  readonly source: Uint8Array | Uint8ClampedArray
  readonly sourceSize: number
  readonly outputSize: number
  readonly settings: OctopusSwimSettings
  /** Defaults to `straight`, which is what a canvas returns. */
  readonly sourceAlpha?: OctopusSwimSourceAlpha
}

/**
 * Builds a renderer that premultiplies the source once and reuses it for every
 * frame. Rendering a whole loop through {@link renderOctopusSwimFrame} would
 * repeat that work for each frame, which is the dominant cost on a large icon.
 *
 * The source should already be close to `outputSize`; this resamples with a
 * bilinear filter, which is a poor way to shrink a much larger image. Resize
 * first with whatever the host platform provides.
 */
export function createOctopusSwimRenderer(
  options: OctopusSwimRendererOptions,
): OctopusSwimRenderer {
  const { source, sourceSize, outputSize, settings } = options
  const sourceAlpha = options.sourceAlpha ?? 'straight'
  const restoreStraightAlpha = sourceAlpha === 'straight'
  const frameCount = octopusSwimFrameCount(settings)
  const usable = outputSize > 0 && sourceSize > 0
  const premultiplied = usable
    ? premultiply(source, sourceSize, sourceAlpha)
    : new Float32Array(0)
  const inset = outputSize * settings.paddingRatio
  const scale = usable ? (outputSize - inset * 2) / sourceSize : 0

  function renderFrame(frameIndex: number): Uint8ClampedArray {
    const output = new Uint8ClampedArray(Math.max(0, outputSize) * Math.max(0, outputSize) * 4)
    if (!usable || scale <= 0) return output

    const position = (((frameIndex % frameCount) + frameCount) % frameCount) / frameCount
    const span = Math.max(1, outputSize - 1)
    const turn = Math.PI * 2 * position
    const sinTurn = Math.sin(turn)
    const sway = (settings.swayPercent / 100) * outputSize
    const drift = (DRIFT_PERCENT / 100) * outputSize
    const lift = (settings.outerTipLiftPercent / 100) * outputSize
    const bob = (settings.bodyBobPercent / 100) * outputSize * sinTurn
    const pulse = (settings.headPulsePercent / 100) * outputSize * Math.sin(turn * 2)

    for (let y = 0; y < outputSize; y += 1) {
      const down = y / span
      const verticalMotion = settings.paddingRatio > 0
        ? 1
        : smoothstep(0, UNPADDED_EDGE_GUARD_RATIO, down) *
          (1 - smoothstep(1 - UNPADDED_EDGE_GUARD_RATIO, 1, down))
      const tentacle = smoothstep(TENTACLE_RAMP_START, TENTACLE_RAMP_END, down)
      const outer =
        smoothstep(OUTER_LIFT_START, OUTER_LIFT_FULL, down) *
        (1 - OUTER_LIFT_FADE_AMOUNT * smoothstep(OUTER_LIFT_FADE_START, 1, down))
      const head = 1 - smoothstep(HEAD_START, HEAD_END, down)
      const rowPhase = down * settings.waveDown
      const headShift = pulse * head * (HEAD_PIVOT - down)

      for (let x = 0; x < outputSize; x += 1) {
        const across = x / span
        const horizontalMotion = settings.paddingRatio > 0
          ? 1
          : smoothstep(0, UNPADDED_EDGE_GUARD_RATIO, across) *
            (1 - smoothstep(1 - UNPADDED_EDGE_GUARD_RATIO, 1, across))
        const side = (across - 0.5) * 2
        const restPhase = rowPhase + side * settings.leftRightSplit
        const phase = turn + restPhase

        // Subtracting the resting value is what closes the loop: the pixel is back
        // where it started at position zero, and still moving as it passes through.
        const shiftX = sway * tentacle * (Math.sin(phase) - Math.sin(restPhase))
        const shiftY =
          drift * tentacle * (Math.cos(phase + CURL_RADIANS) - Math.cos(restPhase + CURL_RADIANS)) +
          lift * side * Math.abs(side) * outer * sinTurn +
          headShift

        sampleInto(
          premultiplied,
          sourceSize,
          (x - shiftX * horizontalMotion - inset) / scale,
          (y - (shiftY + bob) * verticalMotion - inset) / scale,
          output,
          (y * outputSize + x) * 4,
          restoreStraightAlpha,
        )
      }
    }

    return output
  }

  return { frameCount, outputSize, renderFrame }
}

/**
 * Renders a single frame. Prefer {@link createOctopusSwimRenderer} when
 * rendering a whole loop.
 */
export function renderOctopusSwimFrame(request: OctopusSwimFrameRequest): Uint8ClampedArray {
  const renderer = createOctopusSwimRenderer({
    source: request.source,
    sourceSize: request.sourceSize,
    outputSize: request.outputSize,
    settings: { ...request.settings, loopSeconds: request.frameCount / OCTOPUS_SWIM_FRAMES_PER_SECOND },
  })
  return renderer.renderFrame(request.frameIndex)
}
