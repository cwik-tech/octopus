import type { ModelSelectionRecord } from "@contracts/agent-model-selection";

/**
 * Model-selection records remain available to callers for diagnostics, but
 * these informational cards are no longer rendered anywhere in chat.
 */
export function ModelSelectionNotice(props: {
  selections: readonly {
    readonly speaker: string;
    readonly selection: ModelSelectionRecord;
    readonly attemptId?: string;
  }[];
}) {
  void props;
  return null;
}
