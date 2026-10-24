/**
 * One turn's ownership of a display channel.
 *
 * Chat surfaces differ in where their endpoint lives and who owns a channel,
 * but every one of them needs the same three things around a model call:
 * reserve the channel before generating, report suffixes into it, and close
 * the bubble exactly once however the turn ends. Keeping that here means a
 * surface cannot accidentally leave a reader waiting on a reply that is never
 * coming.
 *
 * Nothing published here is persisted. The turn's own response remains the
 * authority, which is what allows this channel to be dropped safely.
 */
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'
import type { AgentTextStreamHub } from './agent-text-stream-hub.js'

/**
 * The single bubble a one-speaker turn produces.
 *
 * Shaped `<speaker>:<ordinal>` like the multi-speaker ids, so the renderer's
 * fold and its speaker-label logic need no special case for these surfaces.
 */
const SINGLE_REPLY_ID = "assistant:0";

export interface TurnTextStream {
  /** Absent when this turn does not stream, so the caller passes nothing on. */
  readonly onTextDelta: ((text: string) => void) | undefined;
  /**
   * Announces which model this turn is running on, before it calls it.
   *
   * A turn whose answer is not prose still owes this: the disclosure is about
   * the model, not about the reply, and a proposal uses one exactly as a
   * conversation does. Publishing it is what makes the notice appear while a
   * slow or gated provider is still working, instead of arriving with the
   * answer — the one moment the person no longer needs it.
   */
  readonly publishSelection: (
    speaker: string,
    selection: ModelSelectionRecord,
  ) => void;
  /** Publishes the terminal frame and closes. Idempotent. */
  readonly close: (reason: "completed" | "error") => void;
}

/**
 * Reserve one turn's display channel and hand back the two things the turn
 * needs: somewhere to send suffixes, and one way to close the bubble.
 *
 * Opening before the model call is what lets a subscriber that arrived first
 * stop waiting. Nothing published here is persisted — the turn's own response
 * is still the authority — so a hub that refuses the channel simply means this
 * turn shows no preview.
 */
export function openTurnTextStream(params: {
  hub?: AgentTextStreamHub;
  channelId: string;
  ownerId: string;
  /** False for a turn whose answer is not prose, such as a proposal. */
  streaming: boolean;
}): TurnTextStream {
  const hub = params.hub;
  const silent: TurnTextStream = {
    onTextDelta: undefined,
    publishSelection: () => {},
    close: () => {},
  };
  if (!hub) return silent;
  try {
    // Opened for every turn, not only a streaming one. A proposal publishes no
    // prose — streaming its JSON envelope would put raw machinery on screen —
    // but it still has a model to disclose, and this channel is how a turn
    // says so before it starts.
    hub.openChannel(params.channelId, params.ownerId);
  } catch {
    // The id is already in flight. The turn still runs; it just shows no
    // preview, which is the same outcome as a provider that does not stream.
    return silent;
  }
  let closed = false;
  return {
    onTextDelta: params.streaming
      ? (text: string) => {
          hub.publish(params.channelId, {
            type: "delta",
            replyId: SINGLE_REPLY_ID,
            channel: "text",
            text,
          });
        }
      : undefined,
    publishSelection: (speaker, selection) => {
      hub.publish(params.channelId, {
        type: "selection",
        replyId: SINGLE_REPLY_ID,
        speaker,
        selection,
      });
    },
    close: (reason) => {
      if (closed) return;
      closed = true;
      hub.publish(
        params.channelId,
        reason === "completed"
          ? { type: "final", replyId: SINGLE_REPLY_ID, reason: "completed" }
          : {
              type: "error",
              replyId: SINGLE_REPLY_ID,
              message: "This reply did not complete.",
            },
      );
      hub.closeChannel(params.channelId);
    },
  };
}
