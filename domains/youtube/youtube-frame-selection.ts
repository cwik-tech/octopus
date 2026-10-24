import type { YoutubeFrameScheduleCandidate } from './youtube-frame-types.js'
import type { YoutubeSelectedFrame } from './youtube-frame-types.js'

export function buildYoutubeFrameSchedule(input: {
  readonly durationSeconds: number
  readonly maximumFrames: number
  readonly denseIntervalSeconds?: number
  readonly steps: readonly {
    readonly id: string
    readonly startSeconds: number
    readonly endSeconds: number
    readonly visualCues: readonly {
      readonly timestampSeconds: number
      readonly importance: 'required' | 'supporting'
    }[]
  }[]
}): YoutubeFrameScheduleCandidate[] {
  const requiredCues = input.steps.flatMap((step) => step.visualCues
    .filter((cue) => cue.importance === 'required')
    .map((cue): YoutubeFrameScheduleCandidate => {
      const requested = clamp(cue.timestampSeconds, 0, input.durationSeconds)
      const requiredCueId = `${step.id}:${formatCueTimestamp(requested)}`
      return {
        stepId: step.id,
        timestampSeconds: requested,
        requestedTimestampSeconds: requested,
        selectionReason: 'required_bracket',
        requiredCueId,
      }
    }))
  if (requiredCues.length > input.maximumFrames) {
    throw new Error('Required YouTube frame cues exceed the decode candidate cap.')
  }
  let remaining = input.maximumFrames - requiredCues.length
  const requiredBrackets: YoutubeFrameScheduleCandidate[] = []
  for (const cue of requiredCues) {
    for (const offset of [-0.5, 0.5]) {
      if (remaining === 0) break
      requiredBrackets.push({
        ...cue,
        timestampSeconds: clamp(cue.timestampSeconds + offset, 0, input.durationSeconds),
      })
      remaining -= 1
    }
  }
  const plannedSupporting = input.steps.flatMap((step) => step.visualCues
    .filter((cue) => cue.importance === 'supporting')
    .map((cue): YoutubeFrameScheduleCandidate => ({
      stepId: step.id,
      timestampSeconds: clamp(cue.timestampSeconds, 0, input.durationSeconds),
      requestedTimestampSeconds: clamp(cue.timestampSeconds, 0, input.durationSeconds),
      selectionReason: 'dense_interval',
    })))
  const boundedSupporting = plannedSupporting.slice(
    0,
    remaining,
  )
  remaining -= boundedSupporting.length
  const supportingBudget = Math.max(
    0,
    remaining,
  )
  const { denseIntervalSeconds } = input
  if (!denseIntervalSeconds || supportingBudget === 0) {
    return [...requiredCues, ...requiredBrackets, ...boundedSupporting]
  }
  const slots = countDenseSlots(input.steps, denseIntervalSeconds)
  const selectedIndices = evenlySpacedIndices(slots, supportingBudget)
  const supporting = selectedIndices.map((index) => {
    const slot = denseSlotAt(input.steps, denseIntervalSeconds, index)
    return {
      stepId: slot.stepId,
      timestampSeconds: slot.timestampSeconds,
      requestedTimestampSeconds: slot.timestampSeconds,
      selectionReason: 'dense_interval' as const,
    }
  })
  return [...requiredCues, ...requiredBrackets, ...boundedSupporting, ...supporting]
}

export function selectBestYoutubeFrameCandidate<T extends {
  readonly actualTimestampSeconds: number
  readonly byteLength: number
  readonly meanLuma?: number
  readonly lumaRange?: number
  readonly blurScore?: number
  readonly valid?: boolean
}>(requestedTimestampSeconds: number, candidates: readonly T[]): T | undefined {
  return [...candidates].filter((candidate) =>
    candidate.valid !== false && Number.isFinite(candidate.actualTimestampSeconds) &&
    (candidate.meanLuma === undefined || Number.isFinite(candidate.meanLuma)) &&
    (candidate.lumaRange === undefined || Number.isFinite(candidate.lumaRange)) &&
    (candidate.blurScore === undefined || Number.isFinite(candidate.blurScore))).sort((left, right) =>
    frameQualityScore(right, requestedTimestampSeconds) -
    frameQualityScore(left, requestedTimestampSeconds))[0]
}

function frameQualityScore(
  candidate: {
    readonly actualTimestampSeconds: number
    readonly byteLength: number
    readonly meanLuma?: number
    readonly lumaRange?: number
    readonly blurScore?: number
  },
  requestedTimestampSeconds: number,
): number {
  const informationScore = candidate.lumaRange ?? Math.log2(Math.max(1, candidate.byteLength))
  const blurPenalty = candidate.blurScore ?? 0
  const distancePenalty = Math.abs(candidate.actualTimestampSeconds - requestedTimestampSeconds)
  return informationScore - blurPenalty * 2 - distancePenalty * 10
}

export function deduplicateYoutubeFrames(
  frames: readonly YoutubeSelectedFrame[],
): YoutubeSelectedFrame[] {
  const required = frames.filter((frame) => frame.importance === 'required')
  const accepted = [...required]
  const supporting = frames.filter((frame) => frame.importance !== 'required').filter((frame) => {
    if (accepted.some((candidate) => equivalentFrame(candidate, frame))) return false
    accepted.push(frame)
    return true
  })
  return [...required, ...supporting].sort((left, right) =>
    left.requestedTimestampSeconds - right.requestedTimestampSeconds)
}

function equivalentFrame(left: YoutubeSelectedFrame, right: YoutubeSelectedFrame): boolean {
  if (left.sha256 === right.sha256) return true
  if (!left.visualHash || !right.visualHash || left.visualHash.length !== right.visualHash.length) return false
  let distance = 0
  for (let index = 0; index < left.visualHash.length; index += 1) {
    const leftNibble = Number.parseInt(left.visualHash.charAt(index), 16)
    const rightNibble = Number.parseInt(right.visualHash.charAt(index), 16)
    if (!Number.isFinite(leftNibble) || !Number.isFinite(rightNibble)) return false
    distance += bitCount(leftNibble ^ rightNibble)
  }
  return distance <= 4
}

function bitCount(value: number): number {
  let count = 0
  for (let current = value; current > 0; current >>>= 1) count += current & 1
  return count
}

function countDenseSlots(
  steps: readonly { readonly startSeconds: number; readonly endSeconds: number }[],
  interval: number,
): number {
  return steps.reduce((total, step) =>
    total + Math.max(0, Math.floor((step.endSeconds - step.startSeconds) / interval) + 1), 0)
}

function denseSlotAt(
  steps: readonly { readonly id: string; readonly startSeconds: number; readonly endSeconds: number }[],
  interval: number,
  requestedIndex: number,
): { readonly stepId: string; readonly timestampSeconds: number } {
  let index = requestedIndex
  for (const step of steps) {
    const count = Math.max(0, Math.floor((step.endSeconds - step.startSeconds) / interval) + 1)
    if (index < count) {
      return { stepId: step.id, timestampSeconds: step.startSeconds + index * interval }
    }
    index -= count
  }
  const last = steps.at(-1)
  if (!last) throw new Error('A frame schedule requires at least one step.')
  return { stepId: last.id, timestampSeconds: last.endSeconds }
}

function evenlySpacedIndices(total: number, maximum: number): number[] {
  if (total <= 0 || maximum <= 0) return []
  const count = Math.min(total, maximum)
  if (count === 1) return [Math.floor((total - 1) / 2)]
  return Array.from({ length: count }, (_, index) =>
    Math.round(index * (total - 1) / (count - 1)))
}

function formatCueTimestamp(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
