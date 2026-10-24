/**
 * One dispatch's view of the display channel.
 *
 * A channel carries every speaker in a run, so each concrete attempt needs its
 * own identity inside it: the `replyId` is the dispatch id, which is what lets
 * the renderer keep one bubble per attempt and lets a retry supersede the one
 * before it rather than appending to it.
 *
 * The sequence matters as much as the text. Frames cross a process boundary
 * here, so the hub dedupes and detects holes by comparing what it last saw for
 * this reply against what arrives. A sequence that restarted mid-answer, or
 * skipped without the frames actually being dropped, would make the hub report
 * loss that did not happen — or worse, miss loss that did.
 *
 * Only committed answer text is forwarded. Reasoning, tool calls and tool
 * results are excluded by kind rather than by position, so private thinking
 * cannot reach a bubble even if a provider interleaves it with the answer.
 */
import type { ProviderProtocolEvent } from '../../contracts/provider.js'
import type { AgentTextStreamInput } from '../../contracts/agent-text-stream.js'

export interface AgentTextDispatchSink {
  /** Display-only. Never throws, and never changes the turn's outcome. */
  onProtocolEvent(event: ProviderProtocolEvent): void
  /** Close this dispatch's bubble. Idempotent. */
  close(reason: 'completed' | 'error' | 'awaiting_input'): void
  /**
   * Wait until everything sent so far has reached the parent. Bounded.
   *
   * The caller is about to record something durable about this dispatch, and
   * that record travels a faster road than these frames do. Ordering the two
   * here is what stops the renderer from being told an attempt is over before
   * the text of it has arrived — which, on a transport that produces its whole
   * answer at the end, means losing the answer entirely.
   */
  flush(): Promise<void>
}

export function createAgentTextDispatchSink(options: {
  sender: {
    send(frame: AgentTextStreamInput): void
    flush(): Promise<void>
  }
  dispatchId: string
}): AgentTextDispatchSink {
  let producerSequence = 0
  let closed = false

  return {
    onProtocolEvent(event) {
      if (closed) return
      if (event.kind !== 'text' || !event.text) return
      options.sender.send({
        type: 'delta',
        replyId: options.dispatchId,
        channel: 'text',
        text: event.text,
        producerSequence: producerSequence++,
      })
    },
    flush() {
      return options.sender.flush()
    },
    close(reason) {
      if (closed) return
      closed = true
      options.sender.send(
        reason !== 'error'
          ? {
              type: 'final',
              replyId: options.dispatchId,
              reason,
              producerSequence: producerSequence++,
            }
          : {
              type: 'error',
              replyId: options.dispatchId,
              message: 'This reply did not complete.',
              producerSequence: producerSequence++,
            },
      )
    },
  }
}
