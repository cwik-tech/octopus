import * as fs from 'node:fs'
import * as path from 'node:path'

/** One recorded review step, as the engine wrote it. */
interface ReviewTraceEvent {
  step: string
  iteration?: unknown
  max_iterations?: unknown
  last_verdict?: unknown
}

/**
 * What a child's review loop last did, or `null` when it ran no review.
 *
 * Only a limit that nothing published after it is an ending. The engine writes
 * `loop.max-iterations-reached` *before* the `approve_latest` policies
 * finalize, so a review that used up its rounds and then published the latest
 * draft leaves that marker behind in a run that succeeded. Taking the marker
 * alone as an ending told the user nothing was published about a review that
 * had published, and hid whichever later stage actually blocked.
 */
export function readChildReviewExhaustion(
  assignmentPath: string,
): { iteration: unknown; maxIterations: unknown; lastVerdict: unknown } | null {
  const events = readReviewTrace(assignmentPath)
  let limitIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.step === 'loop.max-iterations-reached') {
      limitIndex = index
      break
    }
  }
  if (limitIndex < 0) return null
  // Anything written after the limit is a result, so the limit was not the end.
  const published = events
    .slice(limitIndex + 1)
    .some((event) => event.step === 'final.write.end')
  if (published) return null
  const limit = events[limitIndex]
  return {
    iteration: limit?.iteration,
    maxIterations: limit?.max_iterations,
    lastVerdict: limit?.last_verdict,
  }
}

/**
 * Whether a child's review ended without approval.
 *
 * The name this backs travels to the user interface as a cause, and the
 * sentence the user reads is written there — so nothing from the run's own
 * text, which can hold a child's stderr, an absolute path or a token, reaches
 * them through it.
 */
export function childReviewRanOutOfRounds(assignmentPath: string): boolean {
  return readChildReviewExhaustion(assignmentPath) !== null
}

function readReviewTrace(assignmentPath: string): ReviewTraceEvent[] {
  const reviewEventsPath = path.join(assignmentPath, 'logs', 'review-events.jsonl')
  let contents: string
  try {
    contents = fs.readFileSync(reviewEventsPath, 'utf8')
  } catch {
    return []
  }
  const events: ReviewTraceEvent[] = []
  for (const line of contents.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { step?: unknown }).step === 'string'
      ) {
        events.push(parsed as ReviewTraceEvent)
      }
    } catch {
      // A half-written line is not a step. The rest of the log still is.
    }
  }
  return events
}
