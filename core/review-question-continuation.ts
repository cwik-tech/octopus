import type { ReviewState } from './types.js'

export function nextReviewTurn(state: Pick<ReviewState, 'iteration' | 'maxIterations' | 'lastVerdict' | 'pendingPhase'>):
  | { kind: 'complete' }
  | { kind: 'limit' }
  | { kind: 'producer' | 'reviewer'; iteration: number } {
  if (state.lastVerdict === 'approve') return { kind: 'complete' }
  if (state.pendingPhase) return { kind: state.pendingPhase, iteration: state.iteration }
  if (state.iteration >= state.maxIterations) return { kind: 'limit' }
  return { kind: 'producer', iteration: state.iteration + 1 }
}
