import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { CreateSelectionRequest } from "@/components/create/create-panel";
import VisualWorkflowBuilder from "@/components/create/visual-workflow-builder";
import WorkflowGeneratorChat from "@/components/create/workflow-generator-chat";
import { ChatWorkspace } from "@/components/shared/chat-shell";
import { WorkspaceRightSidebarContent } from "@/components/sidebar/workspace-right-sidebar";
import { Button } from "@/components/ui/button";
import { fetchChatDefaults } from "@/lib/clients/chat-defaults-client";
import {
  addWorkflowStep,
  assignWorkflowStepAgent,
  assignWorkflowStepTeam,
  buildWorkflowYaml,
  convertWorkflowStepToHumanInput,
  createWorkflowDraft,
  removeWorkflowStep,
  renameWorkflowStep,
  selectWorkflowStepStage,
  updateWorkflowHumanInputPrompt,
} from "@/lib/utils/workflow-yaml-helpers";
import {
  DEFAULT_MODEL_CHOICE,
  type ModelChoice,
} from "@/lib/utils/model-catalog";
import { getWorkflowYaml, updateWorkflowYaml } from "@/lib/clients/session-client";
import { openAgentTextStreamAt } from "@/lib/clients/agent-text-stream-client";
import {
  advancedStreamCursor,
  planDisclosureRecovery,
} from "@/lib/chat/disclosure-recovery";
import {
  EMPTY_STREAMED_TURN,
  applyStreamDelivery,
  type StreamedTurn,
} from "@/lib/chat/streamed-turn";
import {
  cancelGeneratorJob,
  fetchArchitectTurnHistory,
  fetchGeneratorRegistry,
  postGeneratorTurn,
  saveGeneratorDraft,
  validateWorkflowYaml,
} from "@/lib/clients/workflow-generator-client";
import {
  architectSelectionNotices,
  type ArchitectTurnRecord,
} from "@/lib/models/architect-turn-history";
import type {
  ChatTurn,
  WorkflowCreateHandoff,
  WorkflowDraft,
  WorkflowGeneratorRegistry,
  WorkflowStageType,
} from "@/lib/models/workflow-generator-model";
import { confirmWorkflowDraftDiscard } from "@/lib/utils/workflow-draft-guard";

const HEADER_HEIGHT_REM = 2.75;
/** Bounded: it is the turn that ends the recovery, never a timer. */
const MAX_DISCLOSURE_RESUBSCRIBES = 3;


function resolveSavedWorkflowId(params: {
  result: { workflowId?: string };
  fallbackYaml?: string | null;
  fallbackFilename?: string;
  fallbackWorkflowId?: string | null;
}): string {
  const explicitId = params.result.workflowId?.trim();
  if (explicitId) return explicitId;

  const yamlId = params.fallbackYaml
    ?.match(/^\s*id:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]
    ?.trim();
  if (yamlId) return yamlId.replace(/\.ya?ml$/i, "");

  const filenameId = params.fallbackFilename?.replace(/\.ya?ml$/i, "").trim();
  if (filenameId) return filenameId;

  const fallbackId = params.fallbackWorkflowId?.trim();
  if (fallbackId) return fallbackId;

  throw new Error("Workflow save response did not include a workflow id.");
}

interface WorkflowArchitectPanelProps {
  detailsOpen?: boolean;
  headerContent?: ReactNode;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  topOffsetRem?: number;
  onTeamHandoff?: (prompt: string) => void;
  onResourcesChanged?: (() => Promise<void> | void) | undefined;
  onWorkflowSelectionBlocked?: ((currentWorkflowId: string | null) => void) | undefined;
  workflowSelectionRequest?: CreateSelectionRequest | null | undefined;
}

function WorkflowArchitectPanel({
  detailsOpen = false,
  headerContent,
  onDirtyChange,
  topOffsetRem = 0,
  onTeamHandoff,
  onResourcesChanged,
  onWorkflowSelectionBlocked,
  workflowSelectionRequest,
}: WorkflowArchitectPanelProps) {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pendingHandoff, setPendingHandoff] =
    useState<WorkflowCreateHandoff | null>(null);
  const [yamlErrors, setYamlErrors] = useState<string[]>([]);
  const [yamlDirty, setYamlDirty] = useState(false);
  const [validatingYaml, setValidatingYaml] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  // The picker is prefilled from Settings so a person can see what will run,
  // and it also fills itself in from the catalog. Neither is a choice, and a
  // turn must not be recorded as one — nor override the pair the Workflow
  // Architect Agent names for itself.
  const [chatModelChosen, setChatModelChosen] = useState(false);
  // Read by the prefill, which is an async response that cannot see the state
  // as of when it lands.
  const chatModelChosenRef = useRef(false);
  const chooseChatModel = useCallback((choice: ModelChoice) => {
    chatModelChosenRef.current = true;
    setChatModelChosen(true);
    setChatModel(choice);
  }, []);
  const activeJobIdRef = useRef<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const [streamedTurn, setStreamedTurn] = useState<StreamedTurn>(
    EMPTY_STREAMED_TURN,
  );
  /**
   * How turns that already finished chose their model.
   *
   * Loaded from what the run recorded, never re-derived from Settings: the
   * default moves and a finished turn did not, so re-deriving would relabel
   * history every time somebody changed it.
   */
  const [turnHistory, setTurnHistory] = useState<ArchitectTurnRecord[]>([]);
  /**
   * The turn being watched right now, and the pair it was admitted on.
   *
   * Kept beside the stream rather than in it, because the stream is cleared
   * when the turn ends and this has to outlive that — a person who was told
   * during the wait should not be un-told the moment the answer arrives.
   */
  const [liveSelections, setLiveSelections] = useState<ArchitectTurnRecord[]>(
    [],
  );
  const handledWorkflowSelectionRequestRef = useRef<string | null>(null);
  /**
   * Which history request is the newest one asked for.
   *
   * Two callers ask: the panel on arrival, and every turn as it settles. Their
   * answers can arrive in either order, and an older list applied last would
   * erase a disclosure the newer one carried — a turn whose live notice never
   * arrived would then have no account at all.
   */
  const historyRequestRef = useRef(0);
  /**
   * Cancels every history read when the panel goes away.
   *
   * The reads outlive the turn that asked for them — one is a recovery that
   * runs after a subscription ended — so a turn resolving after unmount must
   * not start or finish another request against state nobody is showing.
   */
  const panelLifetimeRef = useRef<AbortController | null>(null);
  /**
   * Read the recorded history once, and finish before the caller continues.
   *
   * One loader for all three callers — arrival, a settled turn, and the
   * recovery — because they differ only in when they ask. Bounded by the
   * panel's own lifetime and checked on both sides of the await: a turn that
   * resolves after unmount must neither start a request nor apply one.
   */
  const loadTurnHistory = useCallback(async (): Promise<void> => {
    const lifetime = panelLifetimeRef.current;
    if (!lifetime || lifetime.signal.aborted) return;
    const sequence = historyRequestRef.current + 1;
    historyRequestRef.current = sequence;
    try {
      const records = await fetchArchitectTurnHistory(50, lifetime.signal);
      // Only the newest answer is applied, and only while this panel is still
      // showing. An older one describes a moment already moved past, and
      // applying it last would erase a disclosure the newer answer carried.
      if (lifetime.signal.aborted) return;
      if (historyRequestRef.current !== sequence) return;
      setTurnHistory(records);
    } catch {
      // History improves on the live notice rather than replacing it: a failed
      // or cancelled load leaves what the person was already shown, and never
      // touches the draft or the transcript.
    }
  }, []);
  // On arrival: a reopened Create has a transcript with no account of which
  // model produced it until this lands.
  //
  // The lifetime is created here rather than during render, and cleanup aborts
  // *this* generation. A controller made once in render is already aborted by
  // the time StrictMode's second setup runs, and every later read would then
  // refuse to start.
  useEffect(() => {
    const lifetime = new AbortController();
    panelLifetimeRef.current = lifetime;
    void loadTurnHistory();
    return () => {
      lifetime.abort();
      if (panelLifetimeRef.current === lifetime) panelLifetimeRef.current = null;
      // The turn keeps running — it belongs to the server, and closing a view
      // is not stopping work. What stops is this view's reading of it: the
      // subscription is closed, and the job is no longer the active one, so a
      // recovery returning from an aborted read finds nothing to continue and
      // opens no further subscription.
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      activeJobIdRef.current = null;
    };
  }, [loadTurnHistory]);
  const yamlValidationSeq = useRef(0);

  const [saving, setSaving] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    null,
  );
  const [registry, setRegistry] = useState<WorkflowGeneratorRegistry | null>(
    null,
  );
  const [registryError, setRegistryError] = useState<string | null>(null);

  useEffect(() => {
    onDirtyChange?.(yamlDirty);
  }, [onDirtyChange, yamlDirty]);

  useEffect(() => {
    if (!yamlDirty) return;

    const preventDirtyDraftClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventDirtyDraftClose);

    return () => {
      window.removeEventListener("beforeunload", preventDirtyDraftClose);
    };
  }, [yamlDirty]);

  useEffect(() => {
    let cancelled = false;
    void fetchChatDefaults()
      .then((defaults) => {
        // A prefill that arrives after someone has picked is stale. Writing it
        // in would replace their choice while the panel still counts it as one.
        if (!cancelled && !chatModelChosenRef.current) setChatModel(defaults.workflow);
      })
      .catch((error) => {
        console.warn(
          "Failed to load workflow chat model default",
          error instanceof Error ? error.message : error,
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchGeneratorRegistry()
      .then((nextRegistry) => {
        if (cancelled) return;
        setRegistry(nextRegistry);
        setRegistryError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setRegistryError(
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(
    async (text: string) => {
      const jobId = crypto.randomUUID();
      activeJobIdRef.current = jobId;
      setActiveJobId(jobId);
      setChatError(null);
      setPendingHandoff(null);
      setSubmitting(true);
      setStopping(false);
      const nextHistory: ChatTurn[] = [...history, { role: "user", text }];
      setHistory(nextHistory);

      // Subscribe before posting. The job id is the channel id, so the stream
      // can open before the turn that fills it exists; the server waits rather
      // than making the client race.
      const streamAbort = new AbortController();
      streamAbortRef.current?.abort();
      streamAbortRef.current = streamAbort;
      setStreamedTurn(EMPTY_STREAMED_TURN);
      // Whether this turn has said what it runs on at all — not whether a
      // notice is on screen. An explicit choice discloses by saying nothing, so
      // conflating the two would make the recovery chase a notice never owed.
      let selectionSeen = false;
      // A turn can open its stream and then wait a long time before it resolves
      // a pair. A subscription that ends inside that window recovers against a
      // record that does not exist yet, and the frame published afterwards has
      // no listener — so the recovery listens again, a bounded number of times.
      // It is the turn that ends this, never a timer.
      let remainingResubscribes = MAX_DISCLOSURE_RESUBSCRIBES;
      // One reader at a time. A reset says frames were lost, not that the
      // reader is gone, and a second reader beside a live one makes every later
      // delta arrive twice.
      let readerActive = false;
      // Where this turn has been read to, so listening again resumes rather
      // than replays text already painted.
      let nextCursor = 0;
      const recoverMissedDisclosure = async (): Promise<void> => {
        if (
          planDisclosureRecovery({
            activeJobId: activeJobIdRef.current,
            jobId,
            selectionSeen,
            readerActive,
            remainingResubscribes,
          }) === "stop"
        ) {
          return;
        }
        // The stream is a preview and can be missed, and the client returns
        // normally on an exhausted reconnect or a 404 — so "the subscription
        // ended" is not "it delivered". The record the server wrote before it
        // called the model is then the only place the disclosure can come from.
        await loadTurnHistory();
        if (
          planDisclosureRecovery({
            activeJobId: activeJobIdRef.current,
            jobId,
            selectionSeen,
            readerActive,
            remainingResubscribes,
          }) !== "reload-and-resubscribe"
        ) {
          return;
        }
        remainingResubscribes -= 1;
        subscribe();
      };
      const subscribe = (): void => {
        readerActive = true;
        void openAgentTextStreamAt({
          path: "/create/turn",
          channelId: jobId,
          signal: streamAbort.signal,
          fromCursor: nextCursor,
          onDelivery: (delivery) => {
            // A subscription the panel has moved on from paints nothing.
            if (activeJobIdRef.current !== jobId) return;
            nextCursor = advancedStreamCursor(nextCursor, delivery);
            // Read from the delivery, not from the folded state. A functional
            // updater has to stay pure — React may run it twice — so it cannot
            // be the place another piece of state is scheduled from.
            if (delivery.type === "selection") {
              selectionSeen = true;
              const { selection } = delivery;
              setLiveSelections((held) => [
                ...held.filter((entry) => entry.jobId !== jobId),
                { jobId, selection },
              ]);
            }
            if (delivery.type === "reset") {
              // The retained window moved past a frame this subscriber never
              // saw, so the disclosure may be one of the frames it lost.
              void recoverMissedDisclosure();
            }
            setStreamedTurn((current) => applyStreamDelivery(current, delivery));
          },
        })
          .catch(() => {
            // The preview is optional; the turn's own response still arrives.
          })
          .finally(() => {
            // Reached by failure *and* by ordinary resolution: the subscription
            // returns normally once its retries are exhausted, which is not an
            // error and is exactly when a missed frame goes unnoticed.
            readerActive = false;
            void recoverMissedDisclosure();
          });
      };
      subscribe();

      try {
        const result = await postGeneratorTurn({
          jobId,
          history: nextHistory,
          currentDraft: draft,
          ...(chatModelChosen
            ? { provider: chatModel.provider, model: chatModel.model }
            : {}),
        });
        if (activeJobIdRef.current !== jobId) {
          return;
        }
        if (result.cancelled) {
          setHistory((current) => [
            ...current,
            { role: "assistant", text: "Generation stopped." },
          ]);
          return;
        }
        setHistory((current) => [
          ...current,
          { role: "assistant", text: result.message },
        ]);
        setDraft(result.draft);
        setYaml(result.yaml);
        setWarnings(result.warnings ?? []);
        setPendingHandoff(result.handoff ?? null);
        setYamlErrors([]);
        setYamlDirty(false);
        if (result.meta?.fallback) {
          setChatError(result.meta.reason ?? "Architect is offline.");
        }
      } catch (error) {
        if (activeJobIdRef.current !== jobId) {
          return;
        }
        setChatError(error instanceof Error ? error.message : String(error));
      } finally {
        streamAbort.abort();
        // Reloaded once the turn has settled, so the durable record replaces
        // what the stream said — and merged by job, so a load that lands after
        // a newer turn began does not drop it.
        void loadTurnHistory();
        if (activeJobIdRef.current === jobId) {
          // Cleared here rather than when the reply is appended: the preview
          // and the saved reply must not both be on screen for a frame.
          setStreamedTurn(EMPTY_STREAMED_TURN);
          activeJobIdRef.current = null;
          setActiveJobId(null);
          setSubmitting(false);
          setStopping(false);
        }
      }
    },
    // `chatModelChosen` decides whether the pair is sent at all, so it belongs
    // here. No stale read is reachable today — a deliberate pick always creates
    // a fresh `chatModel` object and re-creates this callback with it — but a
    // dependency that is read and not declared is one refactor away from being.
    [
      history,
      draft,
      chatModel,
      chatModelChosen,
      loadTurnHistory,
    ],
  );

  const handleStop = useCallback(async () => {
    const jobId = activeJobIdRef.current;
    if (!jobId || stopping) return;

    // Ownership is handed away here, so the submit path's own cleanup will
    // skip this turn. The preview has to be torn down explicitly or a
    // half-written reply stays on screen for good.
    activeJobIdRef.current = null;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setStreamedTurn(EMPTY_STREAMED_TURN);
    setActiveJobId(null);
    setSubmitting(false);
    setStopping(false);
    setChatError(null);
    setHistory((current) => [
      ...current,
      { role: "assistant", text: "Generation stopped." },
    ]);

    try {
      await cancelGeneratorJob(jobId);
    } catch (error) {
      console.warn(
        "Failed to cancel workflow generator job",
        error instanceof Error ? error.message : error,
      );
    }
  }, [stopping]);

  useEffect(() => {
    if (!yaml) {
      yamlValidationSeq.current += 1;
      return;
    }

    const seq = ++yamlValidationSeq.current;
    const timeout = window.setTimeout(
      () => {
        setValidatingYaml(true);
        void validateWorkflowYaml({ yaml })
          .then((result) => {
            if (seq !== yamlValidationSeq.current) return;
            setWarnings(result.warnings ?? []);
            setYamlErrors(result.errors ?? []);
            setDraft(result.draft);
          })
          .catch((error) => {
            if (seq !== yamlValidationSeq.current) return;
            setYamlErrors([
              error instanceof Error ? error.message : String(error),
            ]);
            setDraft(null);
          })
          .finally(() => {
            if (seq === yamlValidationSeq.current) {
              setValidatingYaml(false);
            }
          });
      },
      yamlDirty ? 450 : 0,
    );

    return () => {
      window.clearTimeout(timeout);
    };
  }, [yaml, yamlDirty]);

  const handleYamlChange = useCallback((nextYaml: string) => {
    setYaml(nextYaml);
    setYamlDirty(true);
    if (!nextYaml.trim()) {
      setDraft(null);
      setWarnings([]);
      setYamlErrors([]);
      setValidatingYaml(false);
    } else {
      setValidatingYaml(true);
    }
  }, []);

  const handleSave = useCallback(
    async (filename?: string) => {
      if (!yaml) return;
      setSaving(true);
      try {
        const result = selectedWorkflowId
          ? await updateWorkflowYaml(selectedWorkflowId, yaml)
          : await saveGeneratorDraft({ yaml, filename });
        const nextWorkflowId = resolveSavedWorkflowId({
          result,
          fallbackYaml: yaml,
          fallbackFilename: result.filename,
          fallbackWorkflowId: selectedWorkflowId,
        });
        if (nextWorkflowId) {
          setSelectedWorkflowId(nextWorkflowId);
        }
        setYamlDirty(false);
        toast.success("Workflow saved", { description: result.filename });
        void onResourcesChanged?.();
      } catch (error) {
        toast.error("Workflow could not be saved", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setSaving(false);
      }
    },
    [onResourcesChanged, selectedWorkflowId, yaml],
  );

  const handleLoadWorkflow = useCallback((id: string, yamlContent: string) => {
    yamlValidationSeq.current += 1;
    setSelectedWorkflowId(id);
    setHistory([
      {
        role: "assistant",
        text: `Loaded workflow **${id}**. You can edit it below or ask me to modify it.`,
      },
    ]);
    setDraft(null);
    setYaml(yamlContent);
    setYamlDirty(false);
    setYamlErrors([]);
    setWarnings([]);
    setValidatingYaml(true);
  }, []);

  useEffect(() => {
    if (!workflowSelectionRequest) return;
    if (
      handledWorkflowSelectionRequestRef.current ===
      workflowSelectionRequest.requestId
    ) {
      return;
    }
    handledWorkflowSelectionRequestRef.current = workflowSelectionRequest.requestId;

    if (!confirmWorkflowDraftDiscard(yamlDirty)) {
      onWorkflowSelectionBlocked?.(selectedWorkflowId);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      setValidatingYaml(true);

      void getWorkflowYaml(workflowSelectionRequest.id)
        .then((yamlContent) => {
          if (cancelled) return;
          handleLoadWorkflow(workflowSelectionRequest.id, yamlContent);
        })
        .catch((error) => {
          if (cancelled) return;
          setValidatingYaml(false);
          toast.error("Workflow could not be loaded", {
            description: error instanceof Error ? error.message : String(error),
          });
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    handleLoadWorkflow,
    onWorkflowSelectionBlocked,
    selectedWorkflowId,
    workflowSelectionRequest,
    yamlDirty,
  ]);

  const handleStepIdChange = useCallback(
    (stepId: string, newId: string): boolean => {
      if (!draft || !newId || newId === stepId) return false;
      const nextDraft = renameWorkflowStep(draft, stepId, newId);
      if (nextDraft === draft) return false;
      setDraft(nextDraft);
      handleYamlChange(buildWorkflowYaml(nextDraft));
      return true;
    },
    [draft, handleYamlChange],
  );

  const handleWorkflowTitleChange = useCallback(
    (title: string) => {
      if (!draft || !title || title === draft.id) return;
      const nextDraft = { ...draft, id: title };
      setDraft(nextDraft);
      handleYamlChange(buildWorkflowYaml(nextDraft));
    },
    [draft, handleYamlChange],
  );

  const handleStepTeamChange = useCallback(
    (stepId: string, teamId: string) => {
      if (!draft) return;
      const nextDraft = assignWorkflowStepTeam(draft, registry, stepId, teamId);
      setDraft(nextDraft);
      handleYamlChange(buildWorkflowYaml(nextDraft));
    },
    [draft, handleYamlChange, registry],
  );

  const handleStepAgentChange = useCallback(
    (stepId: string, teamId: string, agent: string) => {
      if (!draft) return;
      const nextDraft = assignWorkflowStepAgent(
        draft,
        registry,
        stepId,
        teamId,
        agent,
      );
      setDraft(nextDraft);
      handleYamlChange(buildWorkflowYaml(nextDraft));
    },
    [draft, handleYamlChange, registry],
  );

  const handleStepStageChange = useCallback(
    (stepId: string, stageType: WorkflowStageType) => {
      if (!draft) return;
      const nextDraft = selectWorkflowStepStage(
        draft,
        registry,
        stepId,
        stageType,
      );
      setDraft(nextDraft);
      handleYamlChange(buildWorkflowYaml(nextDraft));
    },
    [draft, handleYamlChange, registry],
  );

  const handleAddStep = useCallback(() => {
    const nextDraft = draft
      ? addWorkflowStep(draft, registry)
      : createWorkflowDraft(registry);
    if (!nextDraft) return;
    setDraft(nextDraft);
    handleYamlChange(buildWorkflowYaml(nextDraft));
  }, [draft, registry, handleYamlChange]);

  const handleRemoveStep = useCallback(
    (stepId: string) => {
      if (!draft) return;
      const nextDraft = removeWorkflowStep(draft, stepId);
      setDraft(nextDraft);
      handleYamlChange(nextDraft ? buildWorkflowYaml(nextDraft) : "");
    },
    [draft, handleYamlChange],
  );

  const handleConvertStepToHumanInput = useCallback(
    (stepId: string) => {
      if (!draft) return;
      const nextDraft = convertWorkflowStepToHumanInput(draft, stepId);
      if (nextDraft === draft) return;
      setDraft(nextDraft);
      handleYamlChange(buildWorkflowYaml(nextDraft));
    },
    [draft, handleYamlChange],
  );

  const handleHumanInputPromptChange = useCallback(
    (stepId: string, prompt: string) => {
      if (!draft) return;
      const nextDraft = updateWorkflowHumanInputPrompt(draft, stepId, prompt);
      setDraft(nextDraft);
      handleYamlChange(buildWorkflowYaml(nextDraft));
    },
    [draft, handleYamlChange],
  );

  return (
    <>
      <div
        className="flex h-full min-w-0 flex-col"
        style={{ height: `calc(100dvh - ${HEADER_HEIGHT_REM + topOffsetRem}rem)` }}
      >
        {headerContent}
        <ChatWorkspace className="canvas-glow flex-col pt-2 lg:pt-2">
          <div className="h-full min-w-0">
            <WorkflowGeneratorChat
              history={history}
              streamedTurn={streamedTurn}
              selectionNotices={architectSelectionNotices({
                history: turnHistory,
                live: liveSelections,
                speaker: "Workflow Architect",
              })}
              submitting={submitting}
              stopping={stopping}
              error={chatError}
              onSubmit={handleSubmit}
              onStop={activeJobId ? handleStop : undefined}
              inputDisabled={validatingYaml}
              inputPlaceholder={
                validatingYaml
                  ? "Validating loaded workflow..."
                  : "Describe the workflow you want to build..."
              }
              modelProvider={chatModel.provider}
              model={chatModel.model}
              modelChosen={chatModelChosen}
              onModelChange={chooseChatModel}
              // The picker prefills itself through the same callback a click
              // uses. Showing that value is right; recording it as a choice is
              // not, so it lands here and leaves the turn inheriting.
              onModelAutoSelect={setChatModel}
              footerContent={
                pendingHandoff?.targetMode === "teams" && onTeamHandoff ? (
                  <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {pendingHandoff.reason || "Create a team before continuing."}
                    </span>
                    <Button
                      size="sm"
                      className="h-7 shrink-0 gap-1.5 px-2 text-xs"
                      onClick={() => onTeamHandoff(pendingHandoff.prompt)}
                    >
                      <span>Create team</span>
                      <ArrowRight className="size-3.5" />
                    </Button>
                  </div>
                ) : null
              }
            />
          </div>
        </ChatWorkspace>
      </div>

      <WorkspaceRightSidebarContent active={detailsOpen}>
        <VisualWorkflowBuilder
          draft={draft}
          registry={registry}
          registryError={registryError}
          onWorkflowTitleChange={handleWorkflowTitleChange}
          onStepIdChange={handleStepIdChange}
          onStepTeamChange={handleStepTeamChange}
          onStepAgentChange={handleStepAgentChange}
          onStepStageChange={handleStepStageChange}
          onConvertStepToHumanInput={handleConvertStepToHumanInput}
          onHumanInputPromptChange={handleHumanInputPromptChange}
          onAddStep={handleAddStep}
          onRemoveStep={handleRemoveStep}
          onSaveWorkflow={() => void handleSave()}
          saveDisabled={
            !draft || validatingYaml || yamlErrors.length > 0 || saving
          }
          yamlPreviewProps={{
            yaml,
            onYamlChange: handleYamlChange,
            warnings,
            errors: yamlErrors,
            validating: validatingYaml,
            dirty: yamlDirty,
            saving,
            saved: null,
            saveError: null,
            onSave: handleSave,
            filenameDefault:
              draft?.id ?? selectedWorkflowId ?? undefined,
          }}
        />
      </WorkspaceRightSidebarContent>
    </>
  );
}

export default WorkflowArchitectPanel;
