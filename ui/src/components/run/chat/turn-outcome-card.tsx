import { AlertTriangle, RotateCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ConversationTurnOutcome } from "@contracts/sessions";

/**
 * What happened to a turn that produced no answer.
 *
 * Deliberately not a chat bubble. The agent said nothing, and dressing this up
 * as its reply would be putting words in its mouth — words that would then be
 * read back as history by every turn after it. This is the product speaking
 * about the conversation, not a participant in it.
 *
 * The copy is chosen from a closed set of codes, never from a provider message
 * or an exception string. There is nothing here for a failure to smuggle out.
 */
/**
 * The one outcome whose copy comes from its code rather than its state.
 *
 * `evidence_unreadable` is the fail-closed answer: the durable record could not
 * be read, so nothing is known about how the turn ended. Describing it by state
 * would say "this turn ended before the agent could answer", which is a claim
 * the evidence does not support — and the whole reason this outcome exists is
 * that no claim can be made.
 */
const UNREADABLE_COPY = {
  title: "Status unavailable",
  detail:
    "This turn's record could not be read, so what happened to it cannot be determined.",
};

const OUTCOME_COPY: Record<
  Exclude<ConversationTurnOutcome["state"], "pending">,
  { title: string; detail: string }
> = {
  interrupted: {
    title: "Response interrupted",
    detail:
      "The agent stopped responding and this turn was closed. Nobody knows whether the request reached the model, so it was not retried automatically.",
  },
  "reply-lost": {
    title: "Response not saved",
    detail:
      "The agent produced a reply and it could not be written to this conversation.",
  },
  failed: {
    title: "Response failed",
    detail: "This turn ended before the agent could answer.",
  },
  cancelled: {
    title: "Response cancelled",
    detail: "This turn was stopped before the agent answered.",
  },
};

export function TurnOutcomeCard({
  disabled,
  onRetry,
  outcome,
}: {
  disabled: boolean;
  onRetry: (agentNames: readonly string[]) => void;
  outcome: ConversationTurnOutcome;
}) {
  if (outcome.state === "pending") return null;
  const copy =
    outcome.code === "evidence_unreadable"
      ? UNREADABLE_COPY
      : OUTCOME_COPY[outcome.state];
  // Offered only when the record still says who was asked. Without that, the
  // only routing left is whatever the user happens to have selected now — and
  // sending their question to somebody they did not ask is worse than making
  // them ask again on purpose.
  const roster = outcome.agentNames ?? [];
  const retryable = outcome.retryable && roster.length > 0;

  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <span>{copy.detail}</span>
        {retryable ? (
          <Button
            className="mt-2 w-fit"
            disabled={disabled}
            onClick={() => onRetry(roster)}
            size="sm"
            variant="outline"
          >
            <RotateCw />
            Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
