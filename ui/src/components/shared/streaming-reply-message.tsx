/**
 * One in-flight reply bubble, shared by every chat surface.
 *
 * The states below are the whole point of the component: a preview that lost
 * frames, one that starts mid-answer, and one whose text was discarded at a
 * length limit all have to say so. A surface that rendered only `reply.text`
 * would show partial output as though it were the answer.
 */
import { AgentIdentity } from "@/components/run/shared/agent-identity";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import type { StreamedReply } from "@/lib/chat/streamed-turn";
import { MessageReadingDialog } from "@/components/shared/message-reading-dialog";
import { ResponseTime } from "@/components/shared/response-time";

export function StreamingReplyMessage({
  reply,
  partialView,
  speakerLabel,
  colorClass,
  model,
  provider,
  startedAt,
}: {
  reply: StreamedReply;
  partialView: boolean;
  /** Who is speaking. Surfaces with one speaker pass a fixed label. */
  speakerLabel: string;
  colorClass?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  /** When the question was sent. Without it, no response time is shown. */
  startedAt?: number | undefined;
}) {
  const identity = (
    <AgentIdentity
      className="text-sm"
      colorClass={colorClass}
      name={speakerLabel}
      model={model}
      provider={provider}
    />
  );
  return (
    <Message from="assistant" className="group/message" data-testid="streaming-reply">
      <div className="mb-1 flex items-center justify-between gap-2">
        {identity}
        <div className="flex items-center gap-1">
          {startedAt === undefined ? null : <ResponseTime startedAt={startedAt} />}
          <MessageReadingDialog header={identity} title={speakerLabel}>
            <StreamingReplyContent reply={reply} partialView={partialView} />
          </MessageReadingDialog>
        </div>
      </div>
      <MessageContent>
        <StreamingReplyContent reply={reply} partialView={partialView} />
      </MessageContent>
    </Message>
  );
}

function StreamingReplyContent({
  reply,
  partialView,
}: {
  reply: StreamedReply;
  partialView: boolean;
}) {
  if (reply.failed !== undefined || reply.lost) {
    return (
      <span className="text-xs text-muted-foreground" role="status">
        {reply.failed ?? "Live preview unavailable — waiting for the saved reply."}
      </span>
    );
  }
  return (
    <>
      {partialView ? (
        <span className="mb-1 block text-xs text-muted-foreground" role="status">
          Earlier output not shown
        </span>
      ) : null}
      <MessageResponse>{reply.text}</MessageResponse>
      {reply.truncated ? (
        <span className="mt-1 block text-xs text-muted-foreground" role="status">
          This reply was cut off at its length limit and discarded. Ask
          for a shorter answer, or raise the output limit.
        </span>
      ) : null}
    </>
  );
}
