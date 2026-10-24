import { Check, Copy, Download, MessageSquareText } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AgentIdentity } from "@/components/run/shared/agent-identity";
import { formatAgentDisplayName } from "@/components/run/shared/agent-identity-model";
import { WorkspaceSurfaceCard } from "@/components/run/shared/workspace-journey";
import { MessageReadingDialog } from "@/components/shared/message-reading-dialog";
import { Button } from "@/components/ui/button";
import { messageMarkdownFileName } from "@/components/run/discussion/discussion-message-model";
import { downloadTextFile } from "@/lib/utils/download-file";
import type { WorkflowChatMessage } from "@/lib/utils/workflow-chat-events";
import { cn } from "@/lib/utils/utils";

const COPIED_FEEDBACK_MS = 1500;

export function DiscussionRoundHeader({
  message,
}: {
  message: WorkflowChatMessage;
}) {
  const round = message.workflow.round;
  if (!round) return null;

  return (
    <div
      className="my-4 flex w-full max-w-3xl items-center gap-3"
    >
      <span className="h-px flex-1 bg-border/70" />
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground dark:bg-workspace-card">
        <MessageSquareText className="size-3" />
        Round {round}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

export function DiscussionMessageCard({
  children,
  colorClass,
  message,
  readingContent,
}: {
  children: ReactNode;
  colorClass: string | null;
  message: WorkflowChatMessage;
  readingContent?: ReactNode;
}) {
  const isBrief = message.workflow.messageType === "framing";
  const speakerName = message.speaker?.name ?? "Discussion agent";
  const timestamp = formatMessageTime(message.createdAt);

  return (
    <WorkspaceSurfaceCard
      className={cn(
        "group/message w-full max-w-3xl overflow-hidden rounded-xl px-4 py-3.5 shadow-none",
        isBrief &&
          "border-primary/25 bg-primary/[0.035] dark:border-primary/35 dark:bg-gradient-to-br dark:from-workspace-card dark:to-[color-mix(in_oklab,var(--color-workspace-card)_86%,var(--color-primary))]",
      )}
    >
      <div>
        <AgentIdentity
          avatarSize="md"
          className="mb-3 text-sm"
          colorClass={colorClass}
          model={message.workflow.model}
          name={speakerName}
          provider={message.workflow.provider}
          // The engine's own name for the step that produced the text
          // ("Position", "Probe", "Synthesis"). It is a distinction the reader
          // never acts on, and a failed run already says so in the message
          // body, so the line is off rather than deleted.
          // secondary={
          //   <span className="text-xs capitalize">
          //     {isBrief
          //       ? "Coordinator brief"
          //       : message.workflow.messageType ?? "discussion response"}
          //   </span>
          // }
          trailing={
            <div className="flex shrink-0 items-center gap-0.5 self-start">
              <MessageActions
                createdAt={message.createdAt}
                speakerName={speakerName}
                text={message.text}
                identity={
                  <AgentIdentity
                    avatarSize="md"
                    className="text-sm"
                    colorClass={colorClass}
                    model={message.workflow.model}
                    name={speakerName}
                    provider={message.workflow.provider}
                  />
                }
              >
                {readingContent ?? children}
              </MessageActions>
              {timestamp ? (
                <time
                  aria-label={`Message time: ${timestamp.label}`}
                  className="shrink-0 pl-1 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100"
                  dateTime={message.createdAt}
                  title={timestamp.title}
                >
                  {timestamp.label}
                </time>
              ) : null}
            </div>
          }
        />
        <div className="text-sm leading-[1.6] text-foreground/90">
          {children}
        </div>
      </div>
    </WorkspaceSurfaceCard>
  );
}

/**
 * Keep reading, copying, and downloading beside the response they act on.
 *
 * The buttons stay hidden until the message is hovered or one of them is
 * focused, the way the timestamp beside them already does, so a long
 * transcript reads as prose rather than a column of controls.
 */
function MessageActions({
  children,
  identity,
  createdAt,
  speakerName,
  text,
}: {
  children: ReactNode;
  identity: ReactNode;
  createdAt: string;
  speakerName: string;
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // A denied clipboard is the browser's answer, not a failure worth
      // interrupting the transcript over. The button simply does not confirm.
      return;
    }
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(
      () => setCopied(false),
      COPIED_FEEDBACK_MS,
    );
  };

  const revealClass =
    "opacity-0 transition-opacity group-hover/message:opacity-100 focus-visible:opacity-100";

  return (
    <>
      <Button
        aria-label="Download as MD file"
        className={cn(revealClass, "text-muted-foreground")}
        onClick={() =>
          downloadTextFile(messageMarkdownFileName(speakerName, createdAt), text)
        }
        size="icon-xs"
        title="Download as MD file"
        type="button"
        variant="ghost"
      >
        <Download aria-hidden="true" />
      </Button>
      <Button
        aria-label={copied ? "Response copied" : "Copy the response"}
        className={cn(revealClass, "text-muted-foreground")}
        onClick={() => {
          void handleCopy();
        }}
        size="icon-xs"
        title={copied ? "Response copied" : "Copy the response"}
        type="button"
        variant="ghost"
      >
        {copied ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
      </Button>
      <MessageReadingDialog className={revealClass} header={identity} title={formatAgentDisplayName(speakerName)}>
        {children}
      </MessageReadingDialog>
    </>
  );
}

function formatMessageTime(value: string): {
  label: string;
  title: string;
} | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    label: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
    title: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  };
}
