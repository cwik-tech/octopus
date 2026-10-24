import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { FileIconBar } from "@/components/shared/chat-files/file-icon-bar";
import { FileMessageCard } from "@/components/shared/chat-files/file-message-card";
import { FileUploadNotice } from "@/components/shared/chat-files/file-upload-notice";
import {
  type FileTimelineItem,
  useFileUploadController,
} from "@/components/shared/chat-files/use-file-upload-controller";
import { ChatComposer } from "@/components/shared/chat-composer";
import { ChatShell } from "@/components/shared/chat-shell";
import { AgentIdentity } from "@/components/run/shared/agent-identity";
import type { FileUploadApi } from "@/components/shared/file-upload";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import {
  isModelChoiceAvailable,
  type ModelChoice,
} from "@/lib/utils/model-catalog";
import type { ChatTurn } from "@/lib/models/workflow-generator-model";
import { StreamingReplyMessage } from "@/components/shared/streaming-reply-message";
import { MessageReadingDialog } from "@/components/shared/message-reading-dialog";
import { EMPTY_STREAMED_TURN, type StreamedTurn } from "@/lib/chat/streamed-turn";
import { ModelSelectionNotice } from "@/components/run/chat/model-selection-notice";
import type { ModelSelectionRecord } from "@contracts/agent-model-selection";

type TimelineChatTurn = ChatTurn & { createdAt?: string };

interface WorkflowGeneratorChatProps {
  history: TimelineChatTurn[];
  submitting: boolean;
  stopping?: boolean;
  error: string | null;
  onSubmit: (text: string) => void | Promise<void>;
  onInputChange?: (text: string) => void;
  onStop?: (() => void | Promise<void>) | undefined;
  emptyMessage?: string;
  inputDisabled?: boolean;
  inputPlaceholder?: string;
  title?: string;
  botLabel?: string;
  modelProvider?: string;
  model?: string;
  onModelChange?: (choice: ModelChoice) => void;
  /**
   * Whether the displayed pair is a person's choice rather than a prefill.
   *
   * Only a chosen pair gates submission on its availability. Omitted means the
   * caller does not distinguish the two, and every displayed pair is treated as
   * a choice, which is the behaviour every existing caller already had.
   */
  modelChosen?: boolean;
  /**
   * Where the picker's own prefill goes, when the caller needs to tell it apart
   * from a person's choice. Falls through to `onModelChange` when omitted.
   */
  onModelAutoSelect?: (choice: ModelChoice) => void;
  modelDisabled?: boolean;
  footerContent?: React.ReactNode;
  fileComposer?: WorkflowGeneratorFileComposerConfig;
  additionalTimelineItems?: WorkflowGeneratorTimelineItem[];
  /**
   * The in-flight preview of the reply being generated. Display only: the turn
   * that completes replaces it with the answer the server actually returned.
   */
  streamedTurn?: StreamedTurn;
  /**
   * Which turns ran on the application default, one line per turn.
   *
   * Rendered outside the transcript: a status note is shown to a person, not
   * said by anyone, and it never enters what the model is told.
   */
  selectionNotices?: readonly {
    readonly jobId: string;
    readonly speaker: string;
    readonly selection: ModelSelectionRecord;
    readonly recordedAt?: string;
  }[];
}

export interface WorkflowGeneratorTimelineItem {
  id: string;
  occurredAt: string;
  content: ReactNode;
}

/**
 * Opt-in chat-native file composer. When present, the composer gains a `+`
 * menu with picker/drop/paste upload delegation, attachment cards projected
 * into the timeline, and a current-file icon row. Upload state lives in the
 * shared file-upload controller; this component stays generic and never
 * imports a concrete file client — the caller supplies the API.
 */
export interface WorkflowGeneratorFileComposerConfig {
  /** Existing upload client (e.g. session or Team file API). */
  api: FileUploadApi;
  /** Current owner (draft/session) ID; rotation resets the projection. */
  ownerId: string | null;
  accept?: string;
  maxFiles?: number;
  /** Disables the `+` menu (e.g. while a turn is submitting). */
  disabled?: boolean;
  /** Bump to request an authoritative file-list refresh after a turn. */
  refreshRevision?: number;
}

// Inert API used while no file composer is configured; the controller stays
// inactive because the owner is null, so these never run.
const INACTIVE_FILE_UPLOAD_API: FileUploadApi = {
  list: async () => [],
  upload: async () => {
    throw new Error("File composer is not configured.");
  },
  delete: async () => undefined,
};

const DEFAULT_EMPTY_MESSAGE =
  "Hi — I help you design new workflows from the existing teams. Tell me what you want this workflow to do, and I'll propose a draft you can save.";

const DEFAULT_TITLE = "Workflow Architect";

/** A readable local time, or the raw value when the record's own is unusable. */
function formatTurnTime(recordedAt: string): string {
  const at = new Date(recordedAt);
  return Number.isNaN(at.getTime())
    ? recordedAt
    : at.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

function WorkflowGeneratorChat({
  history,
  submitting,
  stopping = false,
  error,
  onSubmit,
  onInputChange,
  onStop,
  emptyMessage,
  inputDisabled = false,
  inputPlaceholder,
  title,
  botLabel,
  modelProvider,
  model,
  onModelChange,
  onModelAutoSelect,
  modelChosen = true,
  modelDisabled = false,
  footerContent,
  fileComposer,
  additionalTimelineItems = [],
  streamedTurn = EMPTY_STREAMED_TURN,
  selectionNotices = [],
}: WorkflowGeneratorChatProps) {
  const { groups: modelGroups } = useProviderCatalog();
  const headerTitle = title ?? DEFAULT_TITLE;
  const messageLabel = botLabel ?? headerTitle;
  // The picker shows a pair before anyone has chosen one, and that displayed
  // pair is not what the turn will run on: an untouched composer sends no pair
  // at all and the server resolves the Agent's own. Blocking on a displayed
  // default that happens to be unavailable would stop a turn that would have
  // run perfectly well. A pair the person actually chose is different — running
  // something else instead is the substitution this rule exists to prevent.
  const hasAvailableModel =
    !onModelChange ||
    !modelChosen ||
    isModelChoiceAvailable(modelGroups, {
      provider: modelProvider ?? "",
      model: model ?? "",
    });

  const fileComposerActive = Boolean(fileComposer);
  const fileController = useFileUploadController({
    ownerId: fileComposer?.ownerId ?? null,
    api: fileComposer?.api ?? INACTIVE_FILE_UPLOAD_API,
  });
  const {
    upload: uploadFiles,
    refresh: refreshFiles,
    retry: retryFile,
    dismiss: dismissFile,
    remove: removeFile,
    prepareForSubmit: prepareFilesForSubmit,
    reportError: reportFileError,
  } = fileController;
  const fileItemsRef = useRef(fileController.items);
  useEffect(() => {
    fileItemsRef.current = fileController.items;
  }, [fileController.items]);

  // Post-turn refresh: the owner may have parsed/added files during a turn.
  // The initial list already happens on owner change, so only react to bumps.
  const fileRefreshRevision = fileComposer?.refreshRevision ?? 0;
  const lastFileRefreshRevisionRef = useRef(fileRefreshRevision);
  useEffect(() => {
    if (!fileComposer?.ownerId) {
      lastFileRefreshRevisionRef.current = fileRefreshRevision;
      return;
    }
    if (lastFileRefreshRevisionRef.current === fileRefreshRevision) return;
    lastFileRefreshRevisionRef.current = fileRefreshRevision;
    void refreshFiles();
  }, [fileComposer?.ownerId, fileRefreshRevision, refreshFiles]);

  const handleFilesAccepted = useCallback(
    (files: File[]) => {
      const maximum = fileComposer?.maxFiles;
      if (maximum === undefined) {
        void uploadFiles(files);
        return;
      }
      const occupiedNames = new Set(
        fileItemsRef.current
          .filter((item) => item.state !== "error")
          .map((item) => item.filename),
      );
      const accepted: File[] = [];
      for (const file of files) {
        if (occupiedNames.has(file.name)) {
          accepted.push(file);
          continue;
        }
        if (occupiedNames.size >= maximum) continue;
        occupiedNames.add(file.name);
        accepted.push(file);
      }
      if (accepted.length < files.length) {
        reportFileError(
          `A maximum of ${maximum} ${maximum === 1 ? "file" : "files"} can be active at once. Some files were skipped.`,
        );
      }
      if (accepted.length > 0) void uploadFiles(accepted);
    },
    [fileComposer?.maxFiles, reportFileError, uploadFiles],
  );
  const handleFileRetry = useCallback(
    (target: FileTimelineItem) => void retryFile(target.key),
    [retryFile],
  );
  const handleFileDismiss = useCallback(
    (target: FileTimelineItem) => dismissFile(target.key),
    [dismissFile],
  );
  const handleFileDelete = useCallback(
    (target: FileTimelineItem) => removeFile(target.filename),
    [removeFile],
  );

  const chatTimeline = useMemo(() => {
    const turnEntries = history.map((turn, order) => ({
      kind: "turn" as const,
      turn,
      occurredAt: turn.createdAt ?? "",
      order,
    }));
    const fileEntries = fileController.items.map((item, order) => ({
      kind: "file" as const,
      item,
      occurredAt: item.occurredAt,
      order: turnEntries.length + order,
    }));
    const additionalEntries = additionalTimelineItems.map((item, order) => ({
      kind: "additional" as const,
      item,
      occurredAt: item.occurredAt,
      order: turnEntries.length + fileEntries.length + order,
    }));
    return [...turnEntries, ...fileEntries, ...additionalEntries].sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.order - right.order,
    );
  }, [additionalTimelineItems, fileController.items, history]);
  const handleSubmit = async (message: PromptInputMessage) => {
    if (submitting || inputDisabled || !hasAvailableModel) return;
    const text = message.text?.trim();
    if (!text) return;
    if (!(await prepareFilesForSubmit())) return;
    await onSubmit(text);
  };

  return (
    <ChatShell
      label={`${headerTitle} chat`}
      conversation={
        <Conversation>
          {/* Reserve the scrollbar gutter on both edges and pad both sides
              alike, so a user bubble ends as far from the right edge as an
              assistant reply starts from the left. */}
          <ConversationContent
            className="px-1"
            scrollClassName="[scrollbar-gutter:stable_both-edges]!"
          >
            {error ? (
              <div
                className="flex items-center gap-1.5 text-xs text-destructive"
                role="alert"
              >
                <CircleAlert className="size-3.5" />
                {error}
              </div>
            ) : null}
            {history.length === 0 && additionalTimelineItems.length === 0 ? (
              <Message from="assistant">
                <ReadingMessageHeader label={messageLabel} text={emptyMessage ?? DEFAULT_EMPTY_MESSAGE} />
                <MessageContent>
                  <MessageResponse>
                    {emptyMessage ?? DEFAULT_EMPTY_MESSAGE}
                  </MessageResponse>
                </MessageContent>
              </Message>
            ) : null}
            {chatTimeline.map((entry, index) =>
              entry.kind === "additional" ? (
                <div key={`additional-${entry.item.id}`}>{entry.item.content}</div>
              ) : entry.kind === "file" ? (
                fileComposerActive ? (
                  <FileMessageCard
                    key={entry.item.key}
                    item={entry.item}
                    onRetry={handleFileRetry}
                    onDismiss={handleFileDismiss}
                    onDelete={handleFileDelete}
                  />
                ) : null
              ) : (
                <Message from={entry.turn.role} key={`turn-${index}`}>
                  {entry.turn.role === "assistant" ? (
                    <ReadingMessageHeader label={messageLabel} text={entry.turn.text} />
                  ) : null}
                  <MessageContent>
                    <MessageResponse>{entry.turn.text}</MessageResponse>
                  </MessageContent>
                </Message>
              ),
            )}
            {selectionNotices.map((notice) => (
              <div
                key={notice.jobId}
                data-testid={`architect-selection-${notice.jobId}`}
              >
                <ModelSelectionNotice
                  selections={[
                    {
                      // Named by when the turn ran, so a restored line says
                      // which turn it describes rather than relying on an
                      // identity only a test can see. The record's own time,
                      // never today's.
                      speaker: notice.recordedAt
                        ? `${notice.speaker} (${formatTurnTime(notice.recordedAt)})`
                        : notice.speaker,
                      selection: notice.selection,
                      attemptId: notice.jobId,
                    },
                  ]}
                />
              </div>
            ))}
            {streamedTurn.replies.map((reply) => (
              <StreamingReplyMessage
                key={reply.replyId}
                reply={reply}
                partialView={streamedTurn.partialView}
                speakerLabel={messageLabel}
              />
            ))}
            {history.length > 0 &&
            submitting &&
            streamedTurn.replies.length === 0 ? (
              <ThinkingMessage label={messageLabel} />
            ) : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      }
      composer={
        <>
          {footerContent}
          {fileComposerActive ? (
            <FileUploadNotice
              error={fileController.error}
              loading={fileController.loading}
              uploading={fileController.uploading}
              onDismissError={fileController.clearError}
            />
          ) : null}
          {fileComposerActive ? (
            <FileIconBar items={fileController.items} className="mb-2" />
          ) : null}
          <ChatComposer
            placeholder={
              inputPlaceholder ?? "Describe the workflow you want to build…"
            }
            disabled={submitting || inputDisabled || !hasAvailableModel}
            submitting={submitting}
            onSubmit={handleSubmit}
            textareaProps={{ onChange: (event) => onInputChange?.(event.currentTarget.value) }}
            {...(fileComposerActive
              ? {
                  attachments: {
                    label: "Add files",
                    disabled:
                      submitting || inputDisabled || fileComposer?.disabled,
                    accept: fileComposer?.accept,
                    multiple: true,
                    onFilesAccepted: handleFilesAccepted,
                    onError: ({ message }: { message: string }) =>
                      reportFileError(message),
                  },
                }
              : {})}
            {...(onModelChange
              ? {
                  model: {
                    provider: modelProvider,
                    model,
                    onChange: onModelChange,
                    onAutoSelect: onModelAutoSelect,
                    fallbackToFirstAvailable: true,
                    disabled: submitting || inputDisabled || modelDisabled,
                    label: `${headerTitle} model`,
                  },
                }
              : {})}
            stop={
              submitting && onStop
                ? {
                    onStop: () => void onStop(),
                    stopping,
                    label: "Stop generation",
                    stoppingLabel: "Stopping generation",
                  }
                : undefined
            }
          />
        </>
      }
    />
  );
}

function ReadingMessageHeader({ label, text }: {
  label: string;
  text: string;
}) {
  const identity = (
    <AgentIdentity className="text-sm" label={label} name={label} />
  );
  return (
    <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      {identity}
      <MessageReadingDialog header={identity} title={label}>
        <MessageResponse>{text}</MessageResponse>
      </MessageReadingDialog>
    </div>
  );
}

function ThinkingMessage({ label }: { label?: string }) {
  return (
    <Message from="assistant">
      <AgentIdentity
        className="mb-2 text-sm"
        label={label ?? DEFAULT_TITLE}
        name={label ?? DEFAULT_TITLE}
      />
      <MessageContent>
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-live="polite"
          aria-label="Architect is thinking"
        >
          <Shimmer as="span" className="text-sm">
            Thinking…
          </Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
}

export default WorkflowGeneratorChat;
