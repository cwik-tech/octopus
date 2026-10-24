import { OpenInNewWindowButton } from "./open-in-new-window-button";
import { AgentProgress } from '@/components/shared/agent-progress';
import { Check, CircleAlert, Loader2, MessageSquare, Pencil, Plug, Sparkles, X } from "lucide-react";
import { startTransition, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";

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
import {
  PromptInputActionMenuItem,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { McpInteractionList } from "@/components/run/mcp/mcp-interaction-list";
import { McpResourcePickerDialog } from "@/components/run/mcp/mcp-resource-picker-dialog";
import { FileIconBar } from "@/components/shared/chat-files/file-icon-bar";
import { FileMessageCard } from "@/components/shared/chat-files/file-message-card";
import { FileUploadNotice } from "@/components/shared/chat-files/file-upload-notice";
import {
  type FileTimelineItem,
  useFileUploadController,
} from "@/components/shared/chat-files/use-file-upload-controller";
import { ChatComposer } from "@/components/shared/chat-composer";
import { ChatShell } from "@/components/shared/chat-shell";
import { DeliveryMessageCard } from "@/components/run/chat/delivery-message-card";
import { useCanvasDeliveries } from '@/components/canvas/use-canvas-deliveries'
import { AgentQuestionCard } from '@/components/run/chat/agent-question-card';
import { ProjectContextPicker } from "@/components/run/chat/project-context-picker";
import { ChatFolderButton } from "@/components/run/chat/chat-folder-button";
import { FOLDER_TOOLS_UNAVAILABLE_NOTICE } from "@/components/run/chat/folder-tools-notice";
import type { ModelChoiceOffer } from "@contracts/model-choice";
import { ModelChoiceCard } from "@/components/run/chat/model-choice-card";
import { ModelSelectionNotice } from "@/components/run/chat/model-selection-notice";
import { recordedReplyModel } from "@/lib/utils/recorded-model-selection";
import { TurnOutcomeCard } from "@/components/run/chat/turn-outcome-card";
import {
  DiscussionMessageCard,
  DiscussionRoundHeader,
} from "@/components/run/discussion/discussion-message-card";
import { AgentIdentity } from "@/components/run/shared/agent-identity";
import { formatAgentDisplayName } from "@/components/run/shared/agent-identity-model";
import { StreamingReplyMessage } from "@/components/shared/streaming-reply-message";
import { MessageReadingDialog } from "@/components/shared/message-reading-dialog";
import { ResponseTime } from "@/components/shared/response-time";
import { conversationTurnMessageId } from "@contracts/sessions";
import {
  ResearchActivity,
  ResearchSources,
} from "@/components/run/chat/research-activity-list";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import { useResearchActivities } from "@/hooks/use-research-activities";
import {
  agentColorKey,
  buildAgentColorMapFromSpeakers,
} from "@/lib/utils/agent-chat-colors";
import { sessionFileUploadApi } from "@/lib/clients/file-upload-api";
import type { FileUploadApi } from "@/components/shared/file-upload";
import {
  DEFAULT_MODEL_CHOICE,
  isModelChoiceAvailable,
  type ModelChoice,
} from "@/lib/utils/model-catalog";
import {
  approveModelChoice,
  updateSessionTitle as apiUpdateSessionTitle,
} from "@/lib/clients/session-client";
import type {
  ChatMessage,
  RunPlan,
  SessionSummary,
  SessionTask,
  WorkspaceProjectContextSelection,
} from "@/lib/models/session-model";
import { GENERAL_AGENT_LABEL, GENERAL_AGENT_NAME } from "@contracts/front-door";
import { resolveComposerTarget } from "@/components/run/chat/composer-target";
import {
  NO_CONTEXT_RESULTS,
  type ContextResultsState,
} from "@/components/run/chat/use-context-results";
import type { SessionMessageTarget } from "@contracts/schemas/session-requests";
import {
  type InjectedMessage,
  type PendingChatResponse,
  useConversationStream,
} from "@/components/run/chat/use-conversation-stream";
import { useAgentMentions } from "@/components/run/chat/use-agent-mentions";
import { AgentMentionMenu } from "@/components/run/chat/agent-mention-menu";
import type { AgentChatMode } from "@/components/run/pickers/agent-chat-mode-picker";
import { useAgentDialogue } from "@/components/run/chat/use-agent-dialogue";
import { AGENT_DIALOGUE_MAX_AGENTS, AGENT_DIALOGUE_MIN_AGENTS, type AgentDialoguePauseReason, type AgentDialogueRecord } from "@contracts/agent-dialogue";
import { MAX_AGENT_MENTIONS } from "@/lib/utils/agent-mentions";
import { formatDisplayName } from "@/lib/utils/display-name";
import { agentIdFromPath, buildConversationTimeline, isResearchGroupFinished, type ConversationTimelineItem, type HelperModelSelection, type TimelineTask } from "@/lib/utils/chat-timeline";
import type { TeamStreamHandoff } from "@/lib/chat/team-stream-handoff";
import {
  isWorkflowChatMessage,
  type PendingWorkflowAgent,
  type WorkflowChatMessage,
} from "@/lib/utils/workflow-chat-events";

export interface ChatPanelHandle {
  /**
   * Show a line in the conversation. A note the server never stores is kept
   * through reads; a stored message passed with its id is shown once.
   */
  injectMessage: (message: InjectedMessage) => void;
  /** Re-fetch persisted messages from the backend, keeping pending local ones. */
  reloadMessages: () => void;
}

interface ChatPanelProps {
  assistantLabel?: string;
  researchActivityActive?: boolean;
  researchActivityVisibility?: "all" | "conversation";
  composerPlaceholder?: string;
  /** A scheduled task owns this conversation until it finishes. */
  scheduledRunNotice?: string | null;
  conversationAppend?: ReactNode;
  emptyMessage?: string;
  session: SessionSummary | null;
  /** The session exists only on the client; every read of it would be a 404. */
  isDraft?: boolean;
  /**
   * Make the draft durable, returning the id it was published under. Awaited by
   * every action that needs a session to exist before it can be recorded.
   */
  ensureSession?: () => Promise<string>;
  /**
   * Who this composer addresses, when the user has chosen someone.
   *
   * One optional typed target replaces the old conversation mode. Absent means
   * the General Agent answers; a mention in the message overrides it for that
   * turn without disturbing the standing selection.
   */
  target?: SessionMessageTarget | undefined;
  agentChatMode?: AgentChatMode;
  onDialogueActiveChange?: ((sessionId: string, agents: string[] | null) => void) | undefined;
  /**
   * The Team whose discussion this transcript is showing.
   *
   * Presentation only, and deliberately separate from `target`: a Team run
   * that has already finished is still worth reading, but it is not an
   * instruction to address that Team again. Defaults to the Team currently
   * addressed, which is the only Team on screen until history restores one.
   */
  presentationTeamId?: string | null;
  /** Complete roster for Team-scoped mentions. */
  teamMemberNames?: readonly string[];
  /** Prevent a second Team turn while the current Team task is still active. */
  teamRunActive?: boolean;
  /**
   * End the running Team this composer addresses.
   *
   * Supplied by the panel above, which owns the task, and only while the Team
   * is running. Settles once the stop has been answered, and never rejects:
   * the owner reports a failed stop itself.
   */
  onStopTeamRun?: () => Promise<void> | void;
  /**
   * A Workflow run owns this conversation, and the line that says so.
   *
   * Supplied by the panel above, which owns the task, and only while the run is
   * under way. Steering a run that is already moving is not on offer, so the
   * composer refuses the turn rather than taking a message the run would never
   * read. Absent for a scheduled run, which has its own notice, and for a Team
   * run, which the composer states in its own words.
   */
  workflowRunNotice?: string | null;
  /**
   * End the running Workflow this conversation is showing.
   *
   * The same stop the Queue overview offers, reachable from where the run was
   * started. Settles once the stop has been answered, and never rejects: the
   * owner reports a failed stop itself.
   */
  onStopWorkflowRun?: () => Promise<void> | void;
  /**
   * A Workflow selection the user made is still being persisted.
   *
   * The turn has to wait for it. Sending now would be answered against the
   * plan as it was before the pick, which loses the Workflow the user just
   * chose without telling them.
   */
  selectionPending?: boolean;
  /** Include restored workflow turns even when the ephemeral team picker is empty. */
  showWorkflowMessages?: boolean;
  workflowMessages?: WorkflowChatMessage[];
  workflowPendingAgents?: PendingWorkflowAgent[];
  /**
   * A Team run's live previews and, once each attempt ends, what became of
   * them. Display only: the transcript still holds whatever the run recorded.
   */
  teamStreamHandoffs?: TeamStreamHandoff[];
  onSessionUpdated?: (session: SessionSummary) => void;
  onUserMessagePresenceChange?: (sessionId: string, hasUserMessage: boolean) => void;
  onRunPlanUpdated?: (sessionId: string, plan: RunPlan) => void;
  /**
   * The results this conversation may carry, and the ones it will.
   *
   * Owned by the panel above, because Begin workflow reads the same selection
   * from a different control.
   */
  contextResults?: ContextResultsState;
  onTaskStarted?: (sessionId: string, task: SessionTask) => void;
  /**
   * The tasks this session has admitted.
   *
   * Read only to place a Team launch's naming notice: the attempt names the
   * task, and the task names the turn that asked for it.
   */
  sessionTasks?: readonly TimelineTask[];
  /**
   * What each of this run's own background helpers ran on.
   *
   * From the run's own records rather than the session's: these happen in the
   * team runtime, where there is no session store and no chat turn.
   */
  helperSelections?: readonly HelperModelSelection[];
  onPendingResponseChange?: (sessionId: string, pending: boolean) => void;
  projectContext?: WorkspaceProjectContextSelection | undefined;
  onProjectContextChange?: (
    selection: WorkspaceProjectContextSelection | undefined,
  ) => void;
  /** Fired when a valid message starts a chat or workflow-planning turn. */
  onSessionActivityStarted?: ((sessionId: string) => void) | undefined;
  ref?: Ref<ChatPanelHandle>;
}

/**
 * One shared empty list, so a panel with no tasks does not rebuild its timeline
 * on every render for want of a stable default.
 */
const EMPTY_SESSION_TASKS: readonly TimelineTask[] = [];

/** The same, for a run whose helpers have asked nothing. */
const EMPTY_HELPER_SELECTIONS: readonly HelperModelSelection[] = [];

/**
 * How long an unclaimed research group must look finished before it closes.
 *
 * Two browser-activity poll intervals. A shorter window can land in the gap
 * between two browser calls, when every recorded step is briefly terminal.
 */
const RESEARCH_GROUP_SETTLE_MS = 3_000;

type ChatTimelineEntry =
  | {
      kind: "conversation";
      item: ConversationTimelineItem;
      occurredAt: string;
      order: number;
    }
  | {
      kind: "file";
      item: FileTimelineItem;
      occurredAt: string;
      order: number;
    };

function ChatPanel({
  assistantLabel = GENERAL_AGENT_LABEL,
  researchActivityActive = false,
  researchActivityVisibility = "all",
  composerPlaceholder,
  scheduledRunNotice = null,
  conversationAppend,
  emptyMessage,
  session,
  target,
  agentChatMode,
  onDialogueActiveChange,
  contextResults = NO_CONTEXT_RESULTS,
  presentationTeamId,
  teamMemberNames = [],
  teamRunActive = false,
  onStopTeamRun,
  workflowRunNotice = null,
  onStopWorkflowRun,
  selectionPending = false,
  showWorkflowMessages = false,
  workflowMessages = [],
  workflowPendingAgents = [],
  teamStreamHandoffs = [],
  onSessionUpdated,
  onUserMessagePresenceChange,
  onSessionActivityStarted,
  ref,
  onRunPlanUpdated,
  onTaskStarted,
  sessionTasks = EMPTY_SESSION_TASKS,
  helperSelections = EMPTY_HELPER_SELECTIONS,
  onPendingResponseChange,
  projectContext: controlledProjectContext,
  onProjectContextChange,
  isDraft = false,
  ensureSession,
}: ChatPanelProps) {
  const { groups: modelGroups, defaultModel: appDefaultModel } =
    useProviderCatalog();
  const sessionId = session?.id ?? null;
  const composerSessionIdRef = useRef(sessionId);
  useEffect(() => { composerSessionIdRef.current = sessionId; }, [sessionId]);
  const composerLocked =
    teamRunActive || scheduledRunNotice !== null || workflowRunNotice !== null;
  /**
   * The one line above the composer for whatever owns it.
   *
   * A scheduled run wins the slot. It is the only one of the two the composer
   * cannot end, so its "please wait" is the whole story there.
   */
  const runNotice = scheduledRunNotice ?? workflowRunNotice;
  /**
   * The same notice, readable from a submit that is already in flight.
   *
   * A turn is captured on the keypress and handed to `submitTurn` later, and
   * with an attachment "later" is real: the hand-off waits on `fetch` and a
   * `FileReader` before it calls back
   * (`ui/src/components/ai-elements/prompt-input.tsx:786-848`). A run that
   * starts inside that gap has already re-rendered this component, so the ref
   * knows about it while the closure that took the keypress does not.
   *
   * An ordinary passive effect, deliberately. A layout effect was used here on
   * the theory that a commit lands between the keypress and the hand-off and
   * that passive effects flush too late to be seen — but with no attachment
   * the hand-off is a microtask and no commit can interpose at all, and with
   * one the gap spans whole tasks, by which point either kind of effect has
   * long run. The distinction was never observable, so it is not claimed.
   */
  const workflowRunNoticeRef = useRef(workflowRunNotice);
  useEffect(() => {
    workflowRunNoticeRef.current = workflowRunNotice;
  }, [workflowRunNotice]);
  /**
   * Make this conversation durable before an action that has to be recorded
   * against it. A no-op once the session exists, and the single place the
   * failure of that is allowed to stop the action.
   */
  const materialize = useCallback(async () => {
    if (!isDraft || !ensureSession) return;
    await ensureSession();
  }, [ensureSession, isDraft]);
  /**
   * The draft state and the way out of it, readable from a closure whose
   * identity must never change. Synced in an effect rather than during render:
   * only event handlers read these, so being one commit behind is impossible.
   */
  const isDraftRef = useRef(isDraft);
  const materializeRef = useRef(materialize);
  useEffect(() => {
    isDraftRef.current = isDraft;
    materializeRef.current = materialize;
  }, [isDraft, materialize]);
  const [localProjectContext, setLocalProjectContext] =
    useState<WorkspaceProjectContextSelection>();

  useEffect(() => {
    startTransition(() => setLocalProjectContext(undefined));
  }, [sessionId, session?.projectId]);
  const projectContext = onProjectContextChange
    ? controlledProjectContext
    : localProjectContext;
  const setProjectContext = onProjectContextChange ?? setLocalProjectContext;

  const draftAwareFileApi = useMemo<FileUploadApi>(
    () => ({
      // A draft owns no files yet, and the listing endpoint would 404.
      list: async (ownerId) =>
        isDraftRef.current ? [] : sessionFileUploadApi.list(ownerId),
      // Attaching a file is intent enough to make the conversation real.
      upload: async (ownerId, file) => {
        await materializeRef.current();
        return sessionFileUploadApi.upload(ownerId, file);
      },
      delete: async (ownerId, filename) =>
        sessionFileUploadApi.delete(ownerId, filename),
    }),
    [],
  );
  const fileController = useFileUploadController({
    ownerId: sessionId,
    api: draftAwareFileApi,
  });
  const [stopping, setStopping] = useState(false);
  const refreshFiles = fileController.refresh;
  const handleSendSettled = useCallback(() => {
    setStopping(false);
    // The controller handles read failures and ignores an obsolete owner.
    void refreshFiles();
  }, [refreshFiles]);
  const previousTeamActive = useRef(teamRunActive);
  useEffect(() => {
    if (previousTeamActive.current && !teamRunActive) {
      // A Team publishes coverage before its terminal task event.
      void refreshFiles();
    }
    previousTeamActive.current = teamRunActive;
  }, [teamRunActive, refreshFiles]);
  // The stable `refresh` reference, so sendTurn (through onReplyLanded) and
  // the delivery refresh effect do not depend on the whole results object.
  const contextResultsRefresh = contextResults.refresh;
  const {
    messages,
    turnOutcomes,
    modelChoices,
    loading,
    error,
    streamedTurn,
    submitting,
    folderToolsUnavailable,
    pendingResponse,
    injectMessage,
    reload,
    reportError,
    clearError,
    abortReply,
    sendTurn,
  } = useConversationStream({
    sessionId,
    isDraft,
    onUserMessagePresenceChange,
    onPendingResponseChange,
    onSessionActivityStarted,
    onSessionUpdated,
    onRunPlanUpdated,
    onTaskStarted,
    onReplyLanded: contextResultsRefresh,
    onSendSettled: handleSendSettled,
  });
  const dialogue = useAgentDialogue({
    sessionId: agentChatMode === undefined ? null : sessionId,
    isDraft,
    onMessagesChanged: reload,
    onActiveChange: onDialogueActiveChange,
    onActivityStarted: onSessionActivityStarted,
  });
  const { active: dialogueActive, pending: dialoguePending, interjecting: dialogueInterjecting, start: startDialogue, interject: interjectDialogue, refresh: refreshDialogue } = dialogue;

  useImperativeHandle(ref, () => ({
    injectMessage: (message) => {
      injectMessage(message);
    },
    reloadMessages: () => {
      reload();
      refreshDialogue();
    },
  }));
  const researchActivities = useResearchActivities(
    // A draft has no research to report, and the endpoint is session-scoped.
    isDraft ? null : sessionId,
    researchActivityActive ||
      (submitting && pendingResponse?.sessionId === sessionId),
  );
  const visibleResearchActivities = useMemo(
    () => researchActivityVisibility === "conversation"
      ? researchActivities.filter(
          (activity) => activity.activityScopeId === undefined,
        )
      : researchActivities,
    [researchActivities, researchActivityVisibility],
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session?.title ?? "");
  const [savingTitle, setSavingTitle] = useState(false);
  /**
   * The pair a person chose for this composer, if anyone did.
   *
   * The picker shows a pair either way — an empty control is not useful — but
   * showing the application default is not the same as somebody choosing it.
   * Sending the filled-in pair regardless made the server record every turn as
   * `source: user`, so a session named on the default was disclosed as one
   * named on a model a person had picked, which nobody had.
   *
   * Written only by the control's `onChange`, which is a click. A pair somebody
   * deliberately picks is still their choice when it happens to equal the
   * default: what is recorded is who decided, never whether two pairs match.
   */
  const [chosenChatModel, setChosenChatModel] = useState<ModelChoice | null>(
    null,
  );
  /**
   * The application default, read live rather than copied.
   *
   * A copy taken once at startup keeps showing the pair the default *was* while
   * turns dispatch the pair it now *is*, so the page names a model the turn did
   * not use. Reading it from the catalog keeps what is shown and what is used
   * the same thing.
   */
  const appDefaultChatModel = useMemo<ModelChoice | null>(
    () =>
      appDefaultModel
        ? { provider: appDefaultModel.provider, model: appDefaultModel.model }
        : null,
    [appDefaultModel],
  );
  /**
   * What the picker shows: a person's choice, or the application default.
   *
   * There is no third candidate. Reaching for a first catalog entry when no
   * default is set would invent an application-wide default nobody selected,
   * which is the hierarchy this whole rule exists to have removed — so an
   * unset or unusable default leaves the picker with nothing, visibly.
   */
  const chatModel = useMemo<ModelChoice>(
    () => chosenChatModel ?? appDefaultChatModel ?? DEFAULT_MODEL_CHOICE,
    [chosenChatModel, appDefaultChatModel],
  );
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Whether the pair somebody chose can actually run.
   *
   * Only a choice is checked. Without one nothing is sent at all, and what the
   * turn runs on — an Agent's own model, the one application default, or
   * nothing — is decided where the record of it is written. The composer used
   * to decide it anyway, by reading the pair on display: with no default set, a
   * turn addressed to an Agent naming its own provider and model was refused
   * for want of a default it would never have used, and the picker that could
   * have supplied one was disabled by the same absence.
   */
  const chosenChatModelUsable =
    chosenChatModel === null ||
    isModelChoiceAvailable(modelGroups, chosenChatModel);
  /**
   * The Team this turn is addressed to, if any.
   *
   * The typed target is the single input to every routing question here —
   * mention scope, duplicate-launch blocking, and who is announced as
   * answering. Nothing routes off a Team that is merely on screen.
   */
  const targetTeamId = target?.kind === "team" ? target.teamId : null;
  /** The Team the transcript is showing, addressed or restored from history. */
  const discussionTeamId = presentationTeamId ?? targetTeamId;
  // A chat-selected team runs as a task, so its replies arrive as workflow
  // messages. They belong in the transcript just as much as in the rail.
  const showsWorkflowMessages =
    discussionTeamId !== null || showWorkflowMessages;
  const displayedMessages = useMemo(
    () =>
      showsWorkflowMessages ? [...messages, ...workflowMessages] : messages,
    [messages, showsWorkflowMessages, workflowMessages],
  );
  useCanvasDeliveries(isDraft ? null : sessionId, displayedMessages);
  const pendingQuestion = showsWorkflowMessages
    ? workflowMessages.find((message) => message.agentQuestion?.status === 'pending')?.agentQuestion
    : undefined;
  // Keep workflow colors stable when direct replies arrive, and assign each
  // addressee its color before the first response arrives.
  const agentColorByKey = useMemo(
    () => buildAgentColorMapFromSpeakers([
      // The General Agent answers every untargeted turn, so the greeting and
      // its loading line need its color before it has replied.
      { id: GENERAL_AGENT_NAME },
      ...[...(showsWorkflowMessages ? workflowMessages : []), ...messages].flatMap((message) =>
        message.role === "assistant" && message.speaker?.type === "agent"
          ? [message.speaker]
          : [],
      ),
      ...workflowPendingAgents.map((agent) => ({ id: agent.speakerId, name: agent.name })),
      ...(pendingResponse?.sessionId === sessionId ? pendingResponse.agentNames : [])
        .map((name) => ({ id: name })),
      ...(dialogue.record?.participants ?? []).map((agent) => ({ id: agent.id, name: agent.label })),
    ]),
    [
      messages,
      showsWorkflowMessages,
      workflowMessages,
      workflowPendingAgents,
      pendingResponse,
      sessionId,
      dialogue.record?.participants,
    ],
  );
  const conversationTimeline = useMemo(
    () =>
      buildConversationTimeline(
        displayedMessages,
        visibleResearchActivities,
        turnOutcomes,
        modelChoices,
        // What this session recorded about naming itself. Held on the session
        // rather than on a message, because a title is decided after the turn's
        // own record is written.
        session?.titleAttempts ?? [],
        // A Team launch records its naming against the task it admitted, and
        // only the task knows which turn asked for it. Without these the notice
        // has no brief to sit under.
        sessionTasks,
        // What this run's own background helpers ran on. Kept apart from any
        // participant's own selection: naming a job, compressing a discussion
        // and writing its minutes are the application's own work, and
        // attributing one to a member would say that member ran on a model it
        // never used.
        helperSelections,
      ),
    [
      displayedMessages,
      helperSelections,
      modelChoices,
      session?.titleAttempts,
      sessionTasks,
      turnOutcomes,
      visibleResearchActivities,
    ],
  );
  // Between two research calls every recorded step is briefly terminal, so
  // step data alone cannot tell a pause from an end. While this session's own
  // turn is in flight, its research group stays unresolved — open, and labelled
  // as running — for the whole turn. Older groups are matched by turn id, never
  // by session-wide liveness, so a new turn cannot reopen what already settled.
  const inFlightResearchRunId =
    submitting && pendingResponse?.sessionId === sessionId
      ? pendingResponse?.turnId
      : undefined;
  // When this session's turn in flight was sent. Its waiting row and its
  // streamed replies count their response time from here.
  const pendingStartedAt =
    pendingResponse?.sessionId === sessionId
      ? turnStartedAt(messages, pendingResponse.turnId)
      : undefined;
  // What the composer's Stop would end, if anything. A reply is this panel's
  // own request; a running Team and a running Workflow both belong to the task
  // above, which hands down the stop for whichever it is. A Team's launch
  // request is none of the three yet: aborting it could not promise the Team
  // would not start, so the spinner stays until there is a run to stop.
  //
  // A run outranks a reply that is still settling. The two overlap for real —
  // a run claims the conversation the moment its task is seen, which can be
  // while the reply's own request is still open — and the line above this
  // button is already the run's, telling the user this is how they stop it.
  // Ending the reply there would break the only promise on screen and leave
  // the run going. The reply is still stoppable: the run's own stop clears the
  // notice, and Stop goes back to meaning the reply.
  const stopTarget: "reply" | "team" | "workflow" | null =
    teamRunActive && onStopTeamRun
      ? "team"
      : workflowRunNotice !== null && onStopWorkflowRun
        ? "workflow"
        : submitting &&
            pendingResponse?.sessionId === sessionId &&
            pendingResponse.teamId === null
          ? "reply"
          : null;
  const stopLabel =
    stopTarget === "team"
      ? "Stop Team run"
      : stopTarget === "workflow"
        ? "Stop workflow run"
        : "Stop generation";
  const stoppingLabel =
    stopTarget === "team"
      ? "Stopping Team run"
      : stopTarget === "workflow"
        ? "Stopping workflow run"
        : "Stopping generation";
  const handleStop = async () => {
    setStopping(true);
    if (stopTarget === "reply") {
      // The send's own `finally` clears `stopping` once the request settles.
      abortReply();
      return;
    }
    try {
      await (stopTarget === "workflow"
        ? onStopWorkflowRun?.()
        : onStopTeamRun?.());
    } finally {
      setStopping(false);
    }
  };
  // Display-only file projection: owned by the controller (which clears
  // optimistic state and ignores late completions on session switch), merged
  // into the rendered timeline by ISO timestamp. Never sent to any chat API.
  const [mcpPickerOpen, setMcpPickerOpen] = useState(false);
  const uploadFiles = fileController.upload;
  const retryFile = fileController.retry;
  const dismissFile = fileController.dismiss;
  const removeFile = fileController.remove;
  const prepareFilesForSubmit = fileController.prepareForSubmit;
  const mentions = useAgentMentions({
    sessionId,
    target,
    targetTeamId,
    teamMemberNames,
    displayedMessages,
    textareaRef: composerTextareaRef,
  });
  const {
    agents: mentionAgents,
    ready: mentionAgentsReady,
    error: mentionAgentsError,
    retry: retryMentionCatalog,
  } = mentions.catalog;
  const handleFilesAccepted = useCallback(
    (files: File[]) => {
      if (scheduledRunNotice !== null) return;
      void uploadFiles(files);
    },
    [scheduledRunNotice, uploadFiles],
  );
  const handleFileRetry = useCallback(
    (item: FileTimelineItem) => void retryFile(item.key),
    [retryFile],
  );
  const handleFileDismiss = useCallback(
    (item: FileTimelineItem) => dismissFile(item.key),
    [dismissFile],
  );
  const handleFileDelete = useCallback(
    (item: FileTimelineItem) => removeFile(item.filename),
    [removeFile],
  );
  const chatTimeline = useMemo<ChatTimelineEntry[]>(() => {
    const conversationEntries = conversationTimeline.map((item, order) => ({
      kind: "conversation" as const,
      item,
      // An outcome sorts with the question it explains, so it stays under it
      // rather than drifting to wherever the failure happened to be noticed.
      occurredAt:
        item.kind === "message"
          ? item.message.createdAt
          : item.kind === "turn-outcome" ||
              item.kind === "model-selection" ||
              item.kind === "model-choice"
            ? item.userMessage.createdAt
            : item.kind === "session-model-selection"
              ? item.at
              : item.researchActivities[0]?.createdAt ?? "",
      order,
    }));
    const fileEntries = fileController.items.map((item, order) => ({
      kind: "file" as const,
      item,
      occurredAt: item.occurredAt,
      order: conversationEntries.length + order,
    }));
    return [...conversationEntries, ...fileEntries].sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.order - right.order,
    );
  }, [conversationTimeline, fileController.items]);
  const roundHeaderMessageIds = useMemo(() => {
    if (discussionTeamId !== null) return new Set<string>();
    const seenRounds = new Set<string>();
    const messageIds = new Set<string>();
    for (const item of conversationTimeline) {
      if (item.kind !== "message" || !isWorkflowChatMessage(item.message)) {
        continue;
      }
      const { messageType, round, taskId } = item.message.workflow;
      if (!round || messageType === "framing") continue;
      const roundKey = `${taskId}:${round}`;
      if (seenRounds.has(roundKey)) continue;
      seenRounds.add(roundKey);
      messageIds.add(item.message.id);
    }
    return messageIds;
  }, [conversationTimeline, discussionTeamId]);
  const discussionMessageAnchors = useMemo(
    () => buildDiscussionMessageAnchors(workflowMessages),
    [workflowMessages],
  );
  const hasCurrentTurnResearchGroup = conversationTimeline.some(
    (item) => item.kind === "research-group" && item.runId === inFlightResearchRunId,
  );
  // An open progress row is the one running indicator; other placeholders step aside.
  const hasOpenProgress = (streamedTurn.progress ?? []).some((entry) => !entry.closed);

  useEffect(() => {
    startTransition(() => {
      setTitleDraft(session?.title ?? "");
      setEditingTitle(false);
      setSavingTitle(false);
    });
  }, [session?.id, session?.title]);

  // ── cmd-Enter: submit chat message when textarea is focused ───────────────
  // Scoped to the Run tab via natural lifecycle (cleaned up on unmount).
  // The PromptInputTextarea already handles plain Enter → submit; this adds
  // the cmd/ctrl+Enter variant for users who prefer the explicit modifier.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key === 'Enter')) return;
      // Already handled closer to where it was pressed: an open mention list
      // took it as a pick, or the composer itself sent the message.
      if (e.defaultPrevented) return;
      const active = document.activeElement;
      if (active?.tagName !== 'TEXTAREA') return;
      const form = (active as HTMLElement).closest('form');
      const submitBtn = form?.querySelector(
        'button[type="submit"]',
      ) as HTMLButtonElement | null;
      if (!submitBtn?.disabled) {
        form?.requestSubmit();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  /**
   * Approves one offer and reloads the transcript.
   *
   * The approval names the offer and nothing else; the pair that runs is the
   * one the card already showed. Reloading afterwards is what makes the new
   * attempt, and the offer's disappearance, visible.
   */
  const approveOffer = useCallback(
    async (offer: ModelChoiceOffer) => {
      if (!sessionId || offer.scope.kind !== "chat") return;
      try {
        await approveModelChoice(sessionId, offer.scope.turnId, {
          offerId: offer.offerId,
          // Derived from the offer, so a double click sends the same key and
          // the server answers the second one from the first attempt.
          idempotencyKey: `approve:${offer.offerId}`,
        });
        clearError();
      } catch (approveError) {
        reportError(
          approveError instanceof Error
            ? approveError.message
            : String(approveError),
        );
      } finally {
        reload();
      }
    },
    [clearError, reload, reportError, sessionId],
  );

  const submitTurn = useCallback(
    async (
      message: PromptInputMessage,
      /**
       * Where this turn must go, when the caller already knows.
       *
       * A retry of an interrupted turn is the case: the record says who was
       * asked, and by the time the user sees the offer the screen usually
       * does not. Absent for an ordinary submit, which is still routed from
       * the composer.
       */
      routedTo?: SessionMessageTarget,
    ) => {
      if (submitting || dialoguePending || dialogueInterjecting || !sessionId) return;
      const rawText = message.text ?? "";
      const text = rawText.trim();
      if (!text) return;
      const restoreDraft = () => {
        // Only for a composer submit. A retry comes from the card, and its
        // text is an old question the user did not just type — writing it back
        // would overwrite whatever they are in the middle of writing now.
        if (routedTo !== undefined || composerSessionIdRef.current !== sessionId) return;
        const textarea = composerTextareaRef.current;
        if (!textarea) return;
        textarea.value = rawText;
        textarea.setSelectionRange(rawText.length, rawText.length);
      };
      if (scheduledRunNotice !== null) {
        restoreDraft();
        return;
      }
      // A Workflow run this session started reads nothing the user types while
      // it works, so the refusal is real and not only a disabled textarea.
      //
      // Read live rather than from this closure. `PromptInput` captures the
      // text on the keypress and hands the turn over a microtask later, and a
      // run can start inside that gap: the closure that took the keypress
      // still believes the composer was free, so only the ref can refuse the
      // message the run will never read.
      if (workflowRunNoticeRef.current !== null) {
        restoreDraft();
        return;
      }
      // Only the Team this turn would launch can block it. A Team that merely
      // ran earlier in this conversation is history, and history does not get
      // to refuse the next question.
      if (targetTeamId && teamRunActive) {
        restoreDraft();
        return;
      }
      // An active dialogue keeps ownership even if the standing picker changes.
      if (dialogueActive) {
        if (!(await prepareFilesForSubmit())) { restoreDraft(); return; }
        if (!(await interjectDialogue(text))) restoreDraft();
        else clearError();
        return;
      }
      if (
        routedTo === undefined && agentChatMode === "dialogue" && target?.kind === "agents" &&
        target.agentNames.length >= AGENT_DIALOGUE_MIN_AGENTS && target.agentNames.length <= AGENT_DIALOGUE_MAX_AGENTS
      ) {
        try {
          await materialize();
        } catch {
          restoreDraft();
          return;
        }
        if (!(await prepareFilesForSubmit())) return;
        if (!(await startDialogue([...target.agentNames], text, projectContext ? { projectContext } : {}))) restoreDraft();
        else clearError();
        return;
      }
      // The same derivation the line under the composer describes, so what the
      // user was told and where the turn goes cannot disagree. The refusals
      // stay here, where the error copy and the draft restore live. Decided
      // before the draft is published: they read only the composer, and a
      // refused message must not leave an empty session behind.
      const submitTarget = resolveComposerTarget({
        text,
        ...(target ? { target } : {}),
        targetTeamId,
        ...(routedTo ? { routedTo } : {}),
        mentionAgents,
        mentionAgentsReady,
      });
      if (submitTarget.mentionsPending) {
        const catalogError = mentionAgentsError
          ? `Agent mentions are unavailable: ${mentionAgentsError}`
          : "Agents are still loading. Try again.";
        // A failed catalog is asked for again, so the next send can go out.
        retryMentionCatalog();
        reportError(catalogError);
        restoreDraft();
        throw new Error(catalogError);
      }
      if (submitTarget.overflow) {
        const limitError = `A message can mention up to ${MAX_AGENT_MENTIONS} agents.`;
        reportError(limitError);
        restoreDraft();
        throw new Error(limitError);
      }
      // Decided here, where the addressee is finally known, rather than from the
      // composer's own state. A pair somebody chose that can no longer run is
      // worth refusing — quietly sending it, or quietly replacing it, would be
      // worse than saying so — but only for a turn that would have used it. An
      // Agent or a Team runs on its own models, and stopping one of those would
      // be refusing one thing because a different, unrelated thing is broken.
      // Checked before the draft is published, like the refusals above.
      //
      // Said out loud rather than by disabling the composer. A person whose
      // selection has stopped working still has to be able to type, not least
      // because mentioning an Agent is one of the ways out.
      if (
        !chosenChatModelUsable &&
        submitTarget.target?.kind !== "agents" &&
        submitTarget.target?.kind !== "team"
      ) {
        reportError(
          "The model selected for this chat is no longer available. " +
            "Choose another one, or address an Agent that has its own.",
        );
        restoreDraft();
        return;
      }
      // A draft has to become real before its first turn can be recorded. Done
      // before anything optimistic is appended: if the create fails, nothing
      // has been written to the transcript and the composer text goes back.
      try {
        await materialize();
      } catch {
        restoreDraft();
        return;
      }

      // The pick the user just made is still being written. Answering this turn
      // against the plan it is about to replace would silently drop that pick.
      // Stated here as well as on the controls: a disabled composer happens to
      // keep its text out of the submitted form, and that side effect is not
      // something to rely on as the rule.
      // Only the composer's turn is at risk here: it would be routed from the
      // selection currently being written. A routed retry names its own target
      // and does not consult the selection at all, so this guard has nothing
      // to protect — and refusing it silently, from a button that looks
      // enabled, is worse than either alternative.
      if (selectionPending && routedTo === undefined) {
        restoreDraft();
        return;
      }
      const turnTarget: SessionMessageTarget | undefined = submitTarget.target;
      if (!(await prepareFilesForSubmit())) return;
      await sendTurn({
        text,
        target: turnTarget,
        model: chosenChatModel && chosenChatModelUsable ? chosenChatModel : null,
        projectContext,
        restoreDraft,
      });
      // An ordinary Agent can reserve a dialogue through its native tool.
      // Discover it after the answer settles, including a cancelled reservation.
      refreshDialogue();
    },
    [
      chosenChatModelUsable,
      agentChatMode,
      clearError,
      dialogueActive,
      dialoguePending,
      dialogueInterjecting,
      interjectDialogue,
      startDialogue,
      chosenChatModel,
      materialize,
      target,
      selectionPending,
      scheduledRunNotice,
      mentionAgents,
      mentionAgentsError,
      retryMentionCatalog,
      mentionAgentsReady,
      projectContext,
      prepareFilesForSubmit,
      reportError,
      refreshDialogue,
      sendTurn,
      targetTeamId,
      sessionId,
      submitting,
      teamRunActive,
    ],
  );
  // A published delivery is a run that finished, and the transcript is where
  // this component learns about one. Keyed on the count so an ordinary reply
  // does not re-fetch on top of the refresh the send already did.
  const deliveryCount = messages.filter((message) => message.delivery).length;
  useEffect(() => {
    if (deliveryCount > 0) contextResultsRefresh();
  }, [deliveryCount, contextResultsRefresh]);

  /**
   * The composer's own submit.
   *
   * A separate function because `PromptInput` calls its handler with the form
   * event as the second argument, and this turn's routing override occupies
   * that position — passing `submitTurn` straight in would hand it a
   * `FormEvent` where a target belongs.
   */
  const handleSubmit = useCallback(
    (message: PromptInputMessage) => submitTurn(message),
    [submitTurn],
  );

  const handleSaveTitle = useCallback(async () => {
    if (!sessionId) return;
    const title = titleDraft.trim();
    if (!title) {
      reportError("Session title must not be empty");
      return;
    }
    if (title === session?.title) {
      setEditingTitle(false);
      return;
    }

    setSavingTitle(true);
    clearError();
    try {
      await materialize();
      const updated = await apiUpdateSessionTitle(sessionId, title);
      onSessionUpdated?.(updated);
      setEditingTitle(false);
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTitle(false);
    }
  }, [clearError, materialize, onSessionUpdated, reportError, session?.title, sessionId, titleDraft]);

  const renderConversationItem = (item: ConversationTimelineItem): ReactNode =>
    item.kind === "model-choice" ? (
      <ModelChoiceCard
        key={`model-choice-${item.offer.offerId}`}
        offer={item.offer}
        disabled={submitting || composerLocked || dialogue.active}
        onApprove={(offer) => approveOffer(offer)}
      />
    ) : item.kind === "model-selection" ? (
      <ModelSelectionNotice
        key={`model-selection-${item.userMessage.id}`}
        selections={item.selections}
      />
    ) : item.kind === "session-model-selection" ? (
      // The same notice, for a selection with no message to sit under. Keyed by
      // the attempt itself, because that is the only identity it has.
      <ModelSelectionNotice
        key={`session-model-selection-${item.selections
          .map((selection) => selection.attemptId)
          .join("-")}`}
        selections={item.selections}
      />
    ) : item.kind === "turn-outcome" ? (
      <TurnOutcomeCard
        key={`outcome-${item.outcome.turnId}`}
        outcome={item.outcome}
        disabled={submitting || composerLocked || dialogue.active}
        onRetry={(agentNames) => {
          // A new turn, always. The interrupted identity is terminal and stays
          // that way: resending under it would ask the server to replay a turn
          // whose provider outcome nobody knows.
          //
          // Routed from the record rather than the screen. The card only
          // offers this when the record still names the roster, so the target
          // is never inferred from whatever is selected now.
          void submitTurn({ text: item.userMessage.text, files: [] }, {
            kind: "agents",
            agentNames: [...agentNames],
          });
        }}
      />
    ) : item.kind === "research-group" ? (
      <Message
        className="group/message"
        from="assistant"
        key={`research-${item.runId}-${item.agentPath}`}
      >
        <div className="flex items-start justify-between gap-2">
          <AssistantSpeakerLabel
            name={agentIdFromPath(item.agentPath)}
            colorClass={null}
          />
          {item.runId === inFlightResearchRunId &&
          streamedTurn.replies.length === 0 &&
          pendingStartedAt !== undefined ? (
            <ResponseTime startedAt={pendingStartedAt} />
          ) : null}
        </div>
        <MessageContent className="w-full max-w-3xl">
          <ResearchActivity
            activities={item.researchActivities}
            resolved={
              item.runId !== inFlightResearchRunId &&
              isResearchGroupFinished(item.researchActivities)
            }
            settleMs={RESEARCH_GROUP_SETTLE_MS}
          />
          {item.runId === inFlightResearchRunId && streamedTurn.replies.length === 0 && !hasOpenProgress ? (
            <div
              role="status"
              aria-label={`${formatAgentDisplayName(agentIdFromPath(item.agentPath))} is responding`}
              className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
              <span>{isResearchGroupFinished(item.researchActivities)
                ? "Preparing a response…"
                : "Researching…"}</span>
            </div>
          ) : null}
        </MessageContent>
      </Message>
    ) : item.message.role === "system" ? (
      <div
        key={item.message.id}
        className="px-4 py-1 text-center text-xs text-muted-foreground/50 italic"
      >
        {item.message.text}
      </div>
    ) : isWorkflowChatMessage(item.message) ? (
      <Message
        className="max-w-full"
        from="assistant"
        key={item.message.id}
      >
        <JourneyAnchors
          ids={discussionMessageAnchors.before.get(
            item.message.id,
          )}
        />
        {roundHeaderMessageIds.has(item.message.id) ? (
          <DiscussionRoundHeader message={item.message} />
        ) : null}
        <DiscussionMessageCard
          colorClass={
            item.message.speaker?.type === "agent"
              ? agentColorByKey.get(
                  agentColorKey(item.message.speaker),
                ) ?? null
              : null
          }
          message={item.message}
          readingContent={item.message.agentQuestion ? <MessageResponse>{item.message.text}</MessageResponse> : undefined}
        >
          <MessageResponse>{item.message.text}</MessageResponse>
          {item.message.agentQuestion ? <AgentQuestionCard key={item.message.agentQuestion.interactionId} question={item.message.agentQuestion} /> : null}
        </DiscussionMessageCard>
        <JourneyAnchors
          ids={discussionMessageAnchors.after.get(
            item.message.id,
          )}
        />
      </Message>
    ) : (
      <Message
        className="group/message"
        from={item.message.role}
        id={
          item.message.delivery
            ? `workflow-delivery-${item.message.delivery.taskId}`
            : undefined
        }
        key={item.message.id}
      >
        {item.message.role === "assistant" ? (
          <AssistantMessageHeader
            message={item.message}
            assistantLabel={assistantLabel}
            messages={messages}
            agentColorByKey={agentColorByKey}
          />
        ) : null}
        <MessageContent
          className={item.researchActivities.length > 0 ? "w-full max-w-3xl" : undefined}
        >
          {item.researchActivities.length > 0 ? (
            <ResearchActivity
              activities={item.researchActivities}
              resolved
            />
          ) : null}
          <MessageResponse>{item.message.text}</MessageResponse>
          {item.message.cutOff ? (
            <span role="status" aria-label="Reply cut off" className="mt-1 block text-xs text-muted-foreground">Cut off</span>
          ) : null}
          {item.message.delivery?.artifacts?.length ? (
            <DeliveryMessageCard delivery={item.message.delivery} />
          ) : null}
          {item.researchActivities.length > 0 ? (
            <ResearchSources
              activities={item.researchActivities}
              answer={item.message.text}
            />
          ) : null}
        </MessageContent>
      </Message>
    );

  return (
    <ChatShell
      label="Run chat"
      notice={
        folderToolsUnavailable ? (
          <p role="status" className="flex items-center gap-1.5 px-1 pb-2 text-xs text-muted-foreground">
            <CircleAlert className="size-3.5 shrink-0" />
            {FOLDER_TOOLS_UNAVAILABLE_NOTICE}
          </p>
        ) : null
      }
      header={
        <>
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex items-center gap-2 text-sm">
              <MessageSquare className="size-4 text-muted-foreground" />
              {editingTitle && session ? (
                <form
                  className="flex min-w-0 items-center gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSaveTitle();
                  }}
                >
                  <input
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    disabled={savingTitle}
                    autoFocus
                    aria-label="Session title"
                    className="h-8 w-[min(340px,50vw)] rounded-md border border-input bg-background px-2 text-sm font-medium text-foreground shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="icon"
                    disabled={savingTitle}
                    aria-label="Save session title"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Check />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={savingTitle}
                    aria-label="Cancel session title edit"
                    onClick={() => {
                      setTitleDraft(session.title);
                      setEditingTitle(false);
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X />
                  </Button>
                </form>
              ) : (
                <Button
                  variant="ghost"
                  disabled={!session}
                  onClick={() => session && setEditingTitle(true)}
                  className="group/title h-auto min-w-0 gap-1 px-1 py-0.5 text-left text-foreground disabled:opacity-100"
                  aria-label={session ? "Edit session title" : undefined}
                >
                  <span className="truncate">
                    {session?.title ?? "No session selected"}
                  </span>
                  {session ? (
                    <Pencil className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100" />
                  ) : null}
                </Button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {error || dialogue.error ? (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlert className="size-3.5" />
                {error ?? dialogue.error}
              </div>
            ) : null}
            <OpenInNewWindowButton sessionId={session?.id} isDraft={isDraft} />
            <ChatFolderButton
              sessionId={session?.id}
              projectId={session?.projectId}
              isDraft={isDraft}
              ensureSession={ensureSession}
            />
          </div>
        </>
      }
      conversation={
        !session ? (
          <NoSessionPlaceholder />
        ) : loading ? (
          <LoadingPlaceholder />
        ) : (
          <Conversation>
            {/* Reserve the scrollbar gutter on both edges and pad both sides
                alike, so a user bubble ends as far from the right edge as an
                assistant reply starts from the left. */}
            <ConversationContent
              className="px-1"
              scrollClassName="[scrollbar-gutter:stable_both-edges]!"
            >
              {chatTimeline.length === 0 && scheduledRunNotice === null ? (
                <Message from="assistant">
                  <AssistantSpeakerLabel
                    name={assistantLabel}
                    colorClass={agentColorByKey.get(agentColorKey({ id: assistantLabel })) ?? null}
                  />
                  <MessageContent>
                    <MessageResponse>
                      {emptyMessage ??
                          `Hi, I'm the ${GENERAL_AGENT_LABEL}. Ask me anything and I'll answer. If a Team or Workflow would do the job better I'll say so, and you can pick one in the sidebar. Nothing starts until you press **Begin workflow**.`}
                    </MessageResponse>
                  </MessageContent>
                </Message>
              ) : (
                chatTimeline.map((entry) =>
                  entry.kind === "file" ? (
                    <FileMessageCard
                      item={entry.item}
                      key={entry.item.key}
                      onDelete={handleFileDelete}
                      onDismiss={handleFileDismiss}
                      onRetry={handleFileRetry}
                    />
                  ) : (
                    renderConversationItem(entry.item)
                  ),
                )
              )}
              {conversationAppend}
              {/* Published before the provider was asked, so it is here for the
                  whole wait rather than appearing with the finished turn. The
                  persisted notice takes over once the turn's messages arrive. */}
              <ModelSelectionNotice selections={streamedTurn.selections} />
              {streamedTurn.replies.map((reply) => {
                const name = reply.replyId.split(":")[0] ?? assistantLabel;
                // The pair this reply was admitted on, from the turn's own
                // frame. Never today's agent library, which a reply still in
                // flight may already disagree with.
                const admitted = streamedTurn.selections.find(
                  (entry) => entry.replyId === reply.replyId,
                )?.selection;
                return (
                  <StreamingReplyMessage
                    key={reply.replyId}
                    reply={reply}
                    partialView={streamedTurn.partialView}
                    speakerLabel={formatAgentDisplayName(name)}
                    colorClass={agentColorByKey.get(agentColorKey({ id: name }))}
                    model={admitted?.model}
                    provider={admitted?.provider}
                    startedAt={pendingStartedAt}
                  />
                );
              })}
              {(streamedTurn.progress ?? []).filter(entry => !entry.closed).map(entry => (
                <AgentProgress key={`${entry.channelId}:${entry.replyId}`} speaker={formatAgentDisplayName(entry.replyId.split(':')[0] ?? assistantLabel)} snapshot={entry.snapshot} />
              ))}
              {dialogue.currentTurn && !messages.some((message) => message.id === dialogue.currentTurn?.messageId)
                ? dialogue.streamedTurn.replies.map((reply) => {
                    const speaker = dialogue.currentTurn?.speaker;
                    const admitted = dialogue.streamedTurn.selections.find((selection) => selection.replyId === reply.replyId)?.selection;
                    return <StreamingReplyMessage
                      key={`dialogue:${reply.replyId}`}
                      reply={reply}
                      partialView={dialogue.streamedTurn.partialView}
                      speakerLabel={speaker?.label ?? assistantLabel}
                      colorClass={speaker ? agentColorByKey.get(agentColorKey({ id: speaker.id })) : undefined}
                      model={admitted?.model}
                      provider={admitted?.provider}
                    />;
                  }) : null}
              {dialogue.record?.events.filter((event) => event.type === "speaker_failed").map((event) => (
                <p role="status" key={`dialogue-failure:${dialogue.record?.dialogueId}:${event.sequence}`} className="py-1 text-xs text-muted-foreground">
                  {formatAgentDisplayName(event.speaker?.label ?? "An Agent")} could not reply.
                </p>
              ))}
              {dialogue.record && !dialogue.active ? (
                <p role="status" className="py-2 text-xs text-muted-foreground">{dialogueEndLine(dialogue.record)}</p>
              ) : null}
              {pendingResponse?.sessionId === session.id &&
              !hasCurrentTurnResearchGroup &&
              !hasOpenProgress &&
              streamedTurn.replies.length === 0 ? (
                <PendingResponseMessage
                  assistantLabel={assistantLabel}
                  response={pendingResponse}
                  agentColorByKey={agentColorByKey}
                  startedAt={pendingStartedAt}
                />
              ) : null}
              {showsWorkflowMessages
                ? workflowPendingAgents.filter((agent) => !displayedMessages.some((message) =>
                    (message.outcome?.taskId === agent.taskId || message.delivery?.taskId === agent.taskId)
                    && (agent.startedAt === undefined || Date.parse(message.createdAt) >= agent.startedAt),
                  )).map((agent) => (
                    <WorkflowPendingMessage
                      key={agent.id}
                      agent={agent}
                      colorClass={
                        agentColorByKey.get(
                          agentColorKey({ id: agent.speakerId, name: agent.name }),
                        ) ?? null
                      }
                    />
                  ))
                : null}
              {showsWorkflowMessages
                ? teamStreamHandoffs.map((handoff) =>
                    handoff.kind === "streaming" ? (
                      <StreamingReplyMessage
                        key={handoff.dispatchId}
                        reply={handoff.reply}
                        partialView={false}
                        speakerLabel={formatAgentDisplayName(handoff.agentName)}
                      />
                    ) : (
                      <TeamStreamHandoffMessage
                        key={handoff.dispatchId}
                        agentName={handoff.agentName}
                        label={handoff.label}
                        detail={handoff.detail}
                      />
                    ),
                  )
                : null}
              {/* A draft holds no MCP interactions, and polling for them would
                  ask the server about a session it does not have. */}
              {isDraft ? null : <McpInteractionList sessionId={session.id} />}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        )
      }
      composer={
        <>
          {dialogue.active && dialogue.record ? (
            <div className="mb-2 flex items-center gap-2">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground" role="status">
                {dialogue.record.status === "paused" ? "Dialogue paused" : "Dialogue"} · turn {Math.min(dialogue.record.replyCount + 1, dialogue.record.limits.maxTurns)} of up to {dialogue.record.limits.maxTurns}
              </p>
              <Button variant="outline" size="xs" aria-label={dialogue.record.status === "paused" ? "Resume dialogue" : "Pause dialogue"}
                disabled={dialogue.changingState || dialogue.stopping}
                onClick={() => { void (dialogue.record?.status === "paused" ? dialogue.resume() : dialogue.pause()); /* The hook reports control failures. */ }}>
                {dialogue.record.status === "paused" ? "Resume" : "Pause"}
              </Button>
              <Button variant="destructive" size="xs" aria-label="Stop dialogue" disabled={dialogue.stopping}
                onClick={() => { void dialogue.stop(); /* The hook reports control failures in this chat. */ }}>
                {dialogue.stopping ? "Stopping…" : "Stop"}
              </Button>
            </div>
          ) : dialogue.record ? (
            <div className="mb-2 flex justify-end">
              <Button variant="outline" size="xs" aria-label="Keep going" disabled={dialogue.pending || composerLocked || submitting}
                onClick={() => { void dialogue.keepGoing(); /* The hook reports continuation failures. */ }}>
                {dialogue.pending ? "Starting…" : "Keep going"}
              </Button>
            </div>
          ) : null}
          {dialogue.record?.status === "paused" && dialogue.record.pauseReason ? (
            <p role="status" aria-label="Dialogue pause reason" className="mb-2 text-sm text-muted-foreground">
              {dialoguePauseNotice(dialogue.record.pauseReason)}
            </p>
          ) : null}
          {pendingQuestion ? <div className="mb-2 flex items-center justify-between gap-2">
            <p role="status" className="text-sm text-muted-foreground">{formatAgentDisplayName(pendingQuestion.agentDisplayName)} is waiting for your answer.</p>
            <Button variant="outline" size="sm" aria-label="Go to pending question" onClick={() => {
              const card = document.getElementById(`agent-question-${pendingQuestion.interactionId}`);
              card?.scrollIntoView({ block: 'center' });
              card?.querySelector('textarea')?.focus({ preventScroll: true });
            }}>Answer question</Button>
          </div> : null}
          {runNotice !== null ? (
            <p className="mb-2 text-sm text-muted-foreground" role="status">
              {runNotice}
            </p>
          ) : null}
          {session?.projectId ? (
            <div className="mb-2 flex items-center">
              <ProjectContextPicker
                projectId={session.projectId}
                value={projectContext}
                disabled={submitting || composerLocked}
                onChange={setProjectContext}
              />
            </div>
          ) : null}
          <FileUploadNotice
            error={fileController.error}
            loading={fileController.loading}
            uploading={fileController.uploading}
            onDismissError={fileController.clearError}
          />
          <FileIconBar className="mb-2" items={fileController.items} />
          <ChatComposer
            placeholder={
              session
                ? scheduledRunNotice !== null
                  ? "Please wait for scheduled research to finish..."
                  : workflowRunNotice !== null
                  ? "Wait for the workflow to finish, or stop it..."
                  : teamRunActive
                  ? "Wait for the current Team response to finish..."
                  : dialogue.active
                  ? "Jump in…"
                  : target?.kind === "agents"
                  ? "Send a message to the selected agents..."
                  : composerPlaceholder ?? "Send a message..."
                : "Select a session to chat"
            }
            disabled={
              !session || submitting || dialogue.pending || dialogue.interjecting || composerLocked || selectionPending
            }
            submitting={submitting || dialogue.pending || dialogue.interjecting}
            onSubmit={handleSubmit}
            submitLabel="Send message"
            submittingLabel={dialogue.pending ? "Starting dialogue" : "Waiting for response"}
            textareaProps={{
              ref: composerTextareaRef,
              ...mentions.textareaProps,
            }}
            renderTextarea={(textarea) => (
              <Popover
                modal={false}
                open={mentions.menu.open}
                onOpenChange={mentions.menu.onOpenChange}
              >
                {textarea}
                <PopoverTrigger
                  aria-hidden="true"
                  className="sr-only"
                  tabIndex={-1}
                  type="button"
                >
                  Agent mentions
                </PopoverTrigger>
                {mentions.menu.open ? (
                  <AgentMentionMenu
                    activeIndex={mentions.menu.activeIndex}
                    agents={mentions.menu.agents}
                    anchor={composerTextareaRef}
                    error={mentions.menu.error}
                    participatingAgentKeys={mentions.menu.participatingAgentKeys}
                    listboxId={mentions.menu.listboxId}
                    loading={mentions.menu.loading}
                    query={mentions.menu.query}
                    onActiveIndexChange={mentions.menu.onActiveIndexChange}
                    onQueryChange={mentions.menu.onQueryChange}
                    onKeyDown={mentions.menu.onKeyDown}
                    onSelect={mentions.menu.onSelect}
                  />
                ) : null}
              </Popover>
            )}
            attachments={{
              label: "Add files or MCP resources",
              disabled: !session || composerLocked,
              multiple: true,
              onFilesAccepted: session ? handleFilesAccepted : undefined,
              onError: ({ message }) => fileController.reportError(message),
              menuItems: (
                <PromptInputActionMenuItem
                  // The picker lists resources against the session as soon as
                  // it opens, so the conversation has to exist first. A failed
                  // create leaves the dialog shut; the error is already on the
                  // sidebar, where the retry lives.
                  onClick={() => {
                    void materialize()
                      .then(() => setMcpPickerOpen(true))
                      .catch(() => undefined);
                  }}
                >
                  <Plug className="mr-2 size-4" /> Add from MCP
                </PromptInputActionMenuItem>
              ),
            }}
            model={{
              provider: chatModel.provider,
              model: chatModel.model,
              onChange: setChosenChatModel,
              disabled: !session || submitting || composerLocked,
              label: "Run chat model",
            }}
            stop={
              stopTarget
                ? {
                    onStop: () => void handleStop(),
                    stopping,
                    label: stopLabel,
                    stoppingLabel,
                  }
                : undefined
            }
          />
        </>
      }
    >
      {sessionId ? (
          <McpResourcePickerDialog
            key={sessionId}
            onImported={() => void fileController.refresh()}
            onOpenChange={setMcpPickerOpen}
            open={mcpPickerOpen}
            sessionId={sessionId}
          />
        ) : null}
    </ChatShell>
  );
}

function dialoguePauseNotice(reason: AgentDialoguePauseReason): string {
  switch (reason) {
    case "speech_interrupted": return "Speech interrupted. Send an interjection or resume.";
    case "voice_unavailable": return "Voice layer unavailable. Reconnect and resume.";
    case "voice_refused": return "The voice layer refused this reply. Check voice access and resume.";
    case "speech_dropped": return "This reply was not played. Resume when the voice layer is ready.";
  }
}

function dialogueEndLine(record: AgentDialogueRecord): string {
  switch (record.endReason) {
    case "passes": return "They had nothing more to add.";
    case "turn_limit": return `Reached the ${record.limits.maxTurns}-turn limit.`;
    case "time_limit": return record.limits.maxMinutes === undefined ? "Reached the time limit." : `Reached the ${record.limits.maxMinutes}-minute limit.`;
    case "stopped": return "Stopped.";
    case "too_few_speakers": return `The dialogue ended because ${record.participants.find((agent) => !agent.active)?.label ?? "an Agent"} could not reply.`;
    case "interrupted": return "The dialogue was interrupted.";
    default: return "The dialogue ended.";
  }
}

/** Persona model/provider for a speaking agent, matched by id then name. */
function WorkflowPendingMessage({
  agent,
  colorClass,
}: {
  agent: PendingWorkflowAgent;
  colorClass: string | null;
}) {
  const selectingTeamMembers = agent.activity === "selecting-team-members";
  const finishingWorkflow = agent.activity === "finalizing-workflow";
  const statusLabel = finishingWorkflow
    ? `${formatAgentDisplayName(agent.name)} is finishing the workflow`
    : selectingTeamMembers
    ? `${formatAgentDisplayName(agent.name)} is selecting Team members`
    : `${formatAgentDisplayName(agent.name)} is thinking`;
  return (
    <Message from="assistant">
      <AssistantSpeakerLabel
        colorClass={colorClass}
        model={agent.model}
        name={agent.name}
        provider={agent.provider}
      />
      <MessageContent>
        <div
          aria-label={statusLabel}
          role="status"
        >
          <Shimmer as="span" className="text-sm">
            {finishingWorkflow ? "Finishing the workflow…" : selectingTeamMembers ? "Selecting the right Team members…" : "Thinking…"}
          </Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
}

interface DiscussionMessageAnchors {
  after: Map<string, string[]>;
  before: Map<string, string[]>;
}

interface DiscussionMessageAnchorIndex {
  firstMessageByTask: Map<string, string>;
  lastMessageByTask: Map<string, string>;
  roundAnchors: Array<{ anchorId: string; messageId: string }>;
}

function indexDiscussionMessageAnchors(
  messages: readonly WorkflowChatMessage[],
): DiscussionMessageAnchorIndex {
  const firstMessageByTask = new Map<string, string>();
  const lastMessageByTask = new Map<string, string>();
  const roundAnchorByKey = new Map<
    string,
    { anchorId: string; isFraming: boolean; messageId: string }
  >();

  for (const message of messages) {
    const { messageType, round, taskId } = message.workflow;
    if (!firstMessageByTask.has(taskId)) {
      firstMessageByTask.set(taskId, message.id);
    }
    lastMessageByTask.set(taskId, message.id);
    if (!round) continue;

    const key = `${taskId}:${round}`;
    const candidate = roundAnchorByKey.get(key);
    if (!candidate || (candidate.isFraming && messageType !== "framing")) {
      roundAnchorByKey.set(key, {
        anchorId: `workflow-round-${taskId}-${round}`,
        isFraming: messageType === "framing",
        messageId: message.id,
      });
    }
  }

  return {
    firstMessageByTask,
    lastMessageByTask,
    roundAnchors: [...roundAnchorByKey.values()],
  };
}

function buildDiscussionMessageAnchors(
  messages: readonly WorkflowChatMessage[],
): DiscussionMessageAnchors {
  const index = indexDiscussionMessageAnchors(messages);
  const before = new Map<string, string[]>();
  for (const [taskId, messageId] of index.firstMessageByTask) {
    appendJourneyAnchor(before, messageId, `workflow-brief-${taskId}`);
  }
  for (const anchor of index.roundAnchors) {
    appendJourneyAnchor(before, anchor.messageId, anchor.anchorId);
  }

  const after = new Map<string, string[]>();
  for (const [taskId, messageId] of index.lastMessageByTask) {
    appendJourneyAnchor(after, messageId, `workflow-writing-${taskId}`);
  }
  return { after, before };
}

function appendJourneyAnchor(
  anchors: Map<string, string[]>,
  messageId: string,
  anchorId: string,
): void {
  anchors.set(messageId, [...(anchors.get(messageId) ?? []), anchorId]);
}

function JourneyAnchors({ ids }: { ids?: readonly string[] | undefined }) {
  return ids?.map((id) => (
    <span
      aria-hidden="true"
      className="block scroll-mt-4"
      id={id}
      key={id}
    />
  )) ?? null;
}

function AssistantMessageHeader({
  message,
  assistantLabel,
  messages,
  agentColorByKey,
}: {
  message: ChatMessage;
  assistantLabel: string;
  /** The transcript, so the reply's own turn record can be found. */
  messages: readonly ChatMessage[];
  agentColorByKey: Map<string, string>;
}) {
  const name = message.speaker?.name ?? assistantLabel;
  const agent = message.speaker?.type === "agent" ? message.speaker : undefined;
  // History is labelled from the execution's own record, never from today's
  // agent library: an agent edited after this reply must not relabel it, and
  // a reply with no record says nothing rather than borrowing a current
  // setting.
  const recorded = recordedReplyModel(messages, message);
  // Both ends come from saved lines: the question is saved when the turn
  // starts, and this reply when its Agent finishes.
  const startedAt = turnStartedAt(messages, message.turnId);
  const completedAt = Date.parse(message.createdAt);
  const identity = (
    <AssistantSpeakerLabel
      name={name}
      model={recorded?.model}
      provider={recorded?.provider}
      colorClass={agent ? agentColorByKey.get(agentColorKey(agent)) ?? null : null}
    />
  );
  return (
    <div className="flex items-start justify-between gap-2">
      {identity}
      <div className="flex items-center gap-1">
        {startedAt === undefined || Number.isNaN(completedAt) ? null : (
          <ResponseTime startedAt={startedAt} completedAt={completedAt} />
        )}
        <MessageReadingDialog header={identity} title={formatAgentDisplayName(name)}>
          <MessageResponse>{message.text}</MessageResponse>
        </MessageReadingDialog>
      </div>
    </div>
  );
}

/**
 * When a turn's question was sent, read from the question's own line.
 *
 * The optimistic copy and the saved copy share one id, so the lookup works
 * before and after the server answers. A line with no turn has no question to
 * measure from.
 */
function turnStartedAt(
  messages: readonly ChatMessage[],
  turnId: string | undefined,
): number | undefined {
  if (turnId === undefined) return undefined;
  const questionId = conversationTurnMessageId(turnId, "user");
  const question = messages.find((message) => message.id === questionId);
  const startedAt = question ? Date.parse(question.createdAt) : Number.NaN;
  return Number.isNaN(startedAt) ? undefined : startedAt;
}

/**
 * Use the same initials avatar for every message, even when historical
 * provider metadata or an identity color is unavailable.
 */
function AssistantSpeakerLabel({
  colorClass,
  model,
  name,
  provider,
}: {
  colorClass: string | null;
  model?: string | undefined;
  name: string;
  provider?: string | undefined;
}) {
  return (
    <AgentIdentity
      className="mb-2 text-sm"
      colorClass={colorClass}
      model={model}
      name={name}
      provider={provider}
    />
  );
}

/**
 * The waiting state before the current turn yields research activity or text.
 */
function PendingResponseMessage({
  assistantLabel,
  response,
  agentColorByKey,
  startedAt,
}: {
  assistantLabel: string;
  response: PendingChatResponse;
  agentColorByKey: Map<string, string>;
  /** When the question was sent. Without it, no response time is shown. */
  startedAt: number | undefined;
}) {
  const copy = getPendingResponseCopy(response, assistantLabel);

  // No model here. Nothing has been admitted yet, and reading one from the
  // agent library would name a pair this turn may never run on.
  return (
    <Message className="group/message" from="assistant">
      <div className="flex items-start justify-between gap-2">
        <AssistantSpeakerLabel
          name={copy.speaker}
          colorClass={agentColorByKey.get(agentColorKey({ id: copy.speaker })) ?? null}
        />
        {startedAt === undefined ? null : <ResponseTime startedAt={startedAt} />}
      </div>
      <MessageContent>
        <div
          aria-label={`${copy.speaker} ${copy.speaker === "Selected agents" ? "are" : "is"} responding`}
          role="status"
        >
          <Shimmer as="span" className="text-sm">
            {copy.text}
          </Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
}

function getPendingResponseCopy(
  response: PendingChatResponse,
  assistantLabel = GENERAL_AGENT_LABEL,
): {
  speaker: string;
  text: string;
} {
  if (response.teamId) {
    return {
      speaker: formatDisplayName(response.teamId),
      text: "Starting the Team…",
    };
  }

  // No explicit addressee means the front door has the turn, answering or
  // readying a plan. There is no separate generic assistant identity, and no
  // second name for the two modes.
  if (response.agentNames.length === 0) {
    return {
      speaker: assistantLabel,
      text: "Reviewing your request…",
    };
  }

  if (response.agentNames.length === 1) {
    return {
      speaker: response.agentNames[0] ?? "Selected agent",
      text: "Preparing a response…",
    };
  }

  return {
    speaker: "Selected agents",
    text: `${formatAgentNames(response.agentNames)} are preparing replies…`,
  };
}

function formatAgentNames(agentNames: string[]): string {
  const displayNames = agentNames.map(formatAgentDisplayName);
  if (displayNames.length <= 2) return displayNames.join(" and ");
  return `${displayNames[0]}, ${displayNames[1]}, and ${displayNames.length - 2} more`;
}

function NoSessionPlaceholder() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <Sparkles className="size-8 text-muted-foreground/60" />
      <div className="max-w-sm space-y-1.5">
        <div className="font-medium text-foreground">Pick or start a session</div>
        <p className="text-sm text-muted-foreground">
          Sessions appear in the sidebar. Use + New to start a fresh thread.
        </p>
      </div>
    </div>
  );
}

function LoadingPlaceholder() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="text-sm text-muted-foreground">Loading messages…</div>
    </div>
  );
}

export default ChatPanel;

/**
 * What a live preview becomes when its run recorded no message for it.
 *
 * A chain step writes its answer to an artifact rather than to the
 * transcript, so there is nothing to replace the bubble with. Showing nothing
 * would leave the user staring at the space where an answer had been, so the
 * bubble stays and says where the answer went instead.
 */
/**
 * What to tell the user about a step that recorded no message.
 *
 * The outcomes are spelled out rather than defaulted, because the default —
 * "completed" — is exactly the wrong thing to say about a step that failed,
 * was skipped, or was cancelled.
 */
function handoffSentence(label: string): string {
  switch (label) {
    case "failed":
      return "This step did not complete, so it produced no answer.";
    case "skipped":
      return "This step was skipped, so it produced no answer.";
    case "cancelled":
      return "This step was cancelled before it finished.";
    case "incomplete":
      return "This run ended before this step finished.";
    case "completed":
      return "This step completed. Its answer went to the run's output.";
    default:
      return `This step completed. Its answer went to ${label}.`;
  }
}

export function TeamStreamHandoffMessage({
  agentName,
  label,
  detail,
}: {
  agentName: string;
  label: string;
  /** Why the step failed, when the run said. */
  detail?: string | undefined;
}) {
  return (
    <Message from="assistant" data-testid="stream-handoff">
      <AssistantSpeakerLabel name={agentName} colorClass={null} />
      <MessageContent>
        <span className="text-xs text-muted-foreground" role="status">
          {handoffSentence(label)}
          {detail ? <span className="mt-1 block">{detail}</span> : null}
        </span>
      </MessageContent>
    </Message>
  );
}
