import type { AgentQuestionInterruption } from '../contracts/agent-questions.js'

/** Unwinds a stage after its host has durably accepted a question outcome. */
export class AgentQuestionInterruptionError extends Error {
  constructor(readonly interruption: AgentQuestionInterruption) {
    super(interruption.kind === 'awaiting_input' ? 'Waiting for the human answer.' : 'Question allowance exhausted.')
    this.name = 'AgentQuestionInterruptionError'
  }
}
