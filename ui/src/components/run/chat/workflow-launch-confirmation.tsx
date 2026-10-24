import { Loader2, Play } from "lucide-react";

import { AgentIdentity } from "@/components/run/shared/agent-identity";

import { GENERAL_AGENT_LABEL } from "@contracts/front-door";

import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import { GENERAL_AGENT_COLOR_CLASS } from "@/lib/utils/agent-chat-colors";
import { formatDisplayName } from "@/lib/utils/display-name";

export function WorkflowLaunchConfirmation({
  canBegin,
  confirmationId,
  isStarting,
  onBegin,
  summary,
  workflowId,
}: {
  canBegin: boolean;
  confirmationId: string;
  isStarting: boolean;
  onBegin: () => void;
  summary?: string | undefined;
  workflowId: string;
}) {
  return (
    <Message
      data-testid="workflow-launch-confirmation"
      from="assistant"
    >
      <AgentIdentity
        className="mb-2 text-sm"
        colorClass={GENERAL_AGENT_COLOR_CLASS}
        name={GENERAL_AGENT_LABEL}
      />
      <MessageContent className="w-full max-w-3xl bg-transparent p-0">
        <Confirmation
          approval={{ id: confirmationId }}
          aria-label="Workflow ready to begin"
          className="gap-3 rounded-xl border-border/70 bg-secondary p-4 shadow-xs"
          role="group"
          state="approval-requested"
        >
          <ConfirmationTitle className="font-semibold text-foreground">
            Ready to begin
          </ConfirmationTitle>
          <ConfirmationRequest>
            <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              {summary ? <p>{summary}</p> : null}
              <p>
                Workflow:{" "}
                <span className="font-medium text-foreground">
                  {formatDisplayName(workflowId)}
                </span>
              </p>
            </div>
          </ConfirmationRequest>
          <ConfirmationActions>
            <ConfirmationAction
              disabled={!canBegin}
              onClick={onBegin}
            >
              {isStarting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {isStarting ? "Starting…" : "Begin workflow"}
            </ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      </MessageContent>
    </Message>
  );
}
