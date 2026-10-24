import type { ModelSelectionRecord } from "@contracts/agent-model-selection";
import type { ChatMessage } from "@/lib/models/session-model";

/**
 * The pair a past reply actually ran on, from its own turn's record.
 *
 * Deliberately not the agent library: an agent edited after a reply was
 * written must not retroactively relabel that reply, and a reply written
 * before provenance existed has to say nothing rather than borrow a current
 * setting. Returns `undefined` for both of those cases, which is what the
 * caller renders as unrecorded.
 */
export function recordedReplyModel(
  messages: readonly ChatMessage[],
  reply: ChatMessage,
): { provider: string; model: string } | undefined {
  const speaker = reply.speaker;
  if (!speaker || speaker.type !== "agent" || reply.turnId === undefined) {
    return undefined;
  }
  const admitted = messages.find(
    (candidate) =>
      candidate.role === "user" && candidate.turnId === reply.turnId,
  )?.turnRequest?.admittedSelections;
  if (!admitted) return undefined;
  const selection: ModelSelectionRecord | undefined =
    admitted[speaker.id] ?? admitted[speaker.name];
  return selection
    ? { provider: selection.provider, model: selection.model }
    : undefined;
}
