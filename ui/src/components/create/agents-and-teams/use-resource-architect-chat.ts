import { hasPlannedWebResearchChoice, RESOURCE_ARCHITECT_TURN_TIMEOUT_MS } from "@contracts/resource-architect";
import {
  isRecoverableResourceBuildJob,
  newestResourceBuildJob,
  restorableResourceBuildJob,
} from "@contracts/resource-build-recovery";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cancelAgentJob } from "@/lib/clients/agent-generator-client";
import { readResourceArchitectConversation, ResourceArchitectConnectionError } from "@/lib/clients/resource-architect-conversation-client";
import type { ResourceArchitectConversation } from "@contracts/schemas/resource-architect-conversation";
import {
  listResourceArchitectMetrics,
  listResourceBuildJobs,
  postResourceArchitectTurn,
  readResourceBuildJob,
  retryResourceBuildJob,
  startResourceBuildJob,
  amendTeamShape,
  amendAgentWebResearch,
  discardResourceBuildTeam,
  readTeamShape,
} from "@/lib/clients/resource-architect-client";
import { changeProposedTeamShape } from "./change-proposed-team-shape";
import type { TeamShape } from "@contracts/schemas/team-shape";
import type {
  ChatTurn,
  CreateResourceRef,
  ResourceArchitectPlan,
  ResourceBuildEvent,
  ResourceBuildJobSnapshot,
  ResourceArchitectOperation,
} from "@/lib/models/resource-architect-model";
import type { ModelSelectionRecord } from "@contracts/agent-model-selection";
import type { ResourceArchitectComposerSelection } from "@contracts/schemas/resource-architect-composer";
import { resourceArchitectReviewWarnings } from "@contracts/schemas/resource-architect-review";
import type { ModelChoice } from "@/lib/utils/model-catalog";
import { openAgentTextStreamAt } from "@/lib/clients/agent-text-stream-client";
import {
  EMPTY_STREAMED_TURN,
  applyStreamDelivery,
  type StreamedTurn,
} from "@/lib/chat/streamed-turn";

const POLL_INTERVAL_MS = 500;
const RECONCILIATION_POLL_INTERVAL_MS = 5_000;
const CONNECTION_UNAVAILABLE = "We couldn't check your request. Your message is still here.";
interface ConversationRecovery {
  draftId: string;
  jobId: string;
  cursor: number;
  deadline: AbortSignal;
}
const PUBLISHED_RESOURCE_EVENT_TYPES = new Set<ResourceBuildEvent["type"]>([
  "agent_created",
  "agent_added",
  "team_created",
  "resource_update_applied",
]);

export function useResourceArchitectChat(options: {
  /** The displayed resolved pair, or null while the composer cannot submit. */
  model: ModelChoice | null;
  modelOrigin?: ResourceArchitectComposerSelection["origin"];
  selectedResource?: CreateResourceRef | undefined;
  onResourcesChanged?: (() => Promise<void> | void) | undefined;
  onSelectResource?: (resource: CreateResourceRef) => void;
}) {
  const { model, modelOrigin = "user-choice", selectedResource, onResourcesChanged, onSelectResource } = options;
  const chosenProvider = model?.provider;
  const chosenModel = model?.model;
  // Build requests retain their existing explicit-choice behavior. Captured
  // composer defaults belong to authoring conversation/proposal requests only.
  const chosenPair = useMemo(
    () => modelOrigin === "user-choice" && chosenProvider && chosenModel
      ? { provider: chosenProvider, model: chosenModel }
      : {},
    [chosenModel, chosenProvider, modelOrigin],
  );
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [restoring, setRestoring] = useState(true);
  const restoredSelectionRef = useRef<CreateResourceRef | null>(null);
  const clearRestoredSelection = useCallback(() => {
    restoredSelectionRef.current = null;
  }, []);
  const [documentReader, setDocumentReader] =
    useState<ModelChoice>(DEFAULT_DOCUMENT_READER);
  const [documentUploadRevision, setDocumentUploadRevision] = useState(0);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  // A reply finishing does not finish authoring. Keep this conversation alive
  // across workspace navigation until its build ends or is discarded.
  const [retainOnNavigation, setRetainOnNavigation] = useState(false);
  // Only default use is disclosed. An Architect that names its own pair made a
  // choice, even when that pair happens to equal the application default, and
  // a note there would describe a setting nobody is overriding.
  const [modelSelections, setModelSelections] = useState<
    {
      id: string;
      occurredAt: string;
      /** The turn this note belongs to, so it can never stand in for another. */
      jobId: string;
      operation: ResourceArchitectOperation;
      selection: ModelSelectionRecord;
    }[]
  >([]);
  // A completed build reopens as an empty chat. Its old diagnostics must also
  // stay cleared when their recovery request arrives after the build record.
  const suppressRestoredConversationRef = useRef(false);
  const liveReviewWarningsRef = useRef(new Set<string>());
  const [restoredReviewNotices, setRestoredReviewNotices] = useState<{
    id: string;
    jobId: string;
    occurredAt: string;
    warnings: string[];
  }[]>([]);
  const [pendingPlan, setPendingPlan] = useState<ResourceArchitectPlan | null>(null);
  // Reads what the server recorded and adds any default use not already shown.
  //
  // Two callers need this and they need the same rule: opening Create, where
  // the records are the only history there is, and a turn the server rejected
  // after the model had already run, whose failure carries no reply for the
  // disclosure to travel on.
  const reconcileRecordedSelections = useCallback(async () => {
    let metrics: Awaited<ReturnType<typeof listResourceArchitectMetrics>>;
    try {
      // Bounded, because this is a recovery read and not part of any turn. A
      // history request that never answers must not keep a reference to the
      // composer's state alive indefinitely.
      metrics = await listResourceArchitectMetrics(
        RECORDED_SELECTION_LIMIT,
        AbortSignal.timeout(RECONCILIATION_TIMEOUT_MS),
      );
    } catch {
      // A server that keeps no turn records still runs Create; it simply has
      // no history to restore.
      return;
    }
    if (suppressRestoredConversationRef.current) return;
    setRestoredReviewNotices((current) => {
      if (suppressRestoredConversationRef.current) return [];
      const known = new Set(current.map((entry) => entry.jobId));
      const restored = metrics.flatMap((metric) => {
        if (metric.status !== "completed" || !metric.review ||
          known.has(metric.jobId) || liveReviewWarningsRef.current.has(metric.jobId)) return [];
        const warnings = resourceArchitectReviewWarnings(metric.review);
        if (warnings.length === 0) return [];
        known.add(metric.jobId);
        return [{
          id: `architect-review:${metric.jobId}`, jobId: metric.jobId,
          occurredAt: metric.recordedAt, warnings,
        }];
      });
      return [...current, ...restored].filter((entry) => !liveReviewWarningsRef.current.has(entry.jobId));
    });
    setModelSelections((current) => {
      if (suppressRestoredConversationRef.current) return [];
      const known = new Set(current.map((entry) => entry.id));
      const restored = metrics.flatMap((metric) => {
        const selection = metric.selection;
        if (selection?.source !== "app-default") return [];
        const id = `architect-model-selection:${metric.jobId}`;
        // One note per turn. A turn that also ran in this session already has
        // its note, and two notes for one operation would read as two
        // decisions.
        if (known.has(id)) return [];
        known.add(id);
        return [{
          id,
          occurredAt: metric.recordedAt,
          jobId: metric.jobId,
          operation: metric.operation,
          selection,
        }];
      });
      return restored.length > 0 ? [...current, ...restored] : current;
    });
  }, []);

  const [pendingPlanCreatedAt, setPendingPlanCreatedAt] = useState<string | null>(null);
  /**
   * The revision the visible plan card was rendered from.
   *
   * Captured once, when the plan arrives, and not re-read before a write: a
   * revision fetched immediately before writing always matches, so the check
   * that detects a plan someone else moved would never fire.
   */
  const [planSnapshot, setPlanSnapshot] = useState<
    {
      planId: string;
      revision: string;
      /** The build this plan was admitted for, when it has one. */
      admitted?: { jobId: string; revision: string };
    } | null
  >(null);
  const planRevision = planSnapshot?.revision ?? null;
  const planAdmitted = planSnapshot?.admitted ?? null;
  /**
   * The plan the card is showing, readable from inside an in-flight reply.
   *
   * The reply is compared against this rather than against the previous
   * snapshot. Comparing against the snapshot admitted an obsolete answer
   * whenever the newer plan's own read was still outstanding, because the
   * snapshot had just been cleared and there was nothing to disagree with.
   */
  const displayedPlanIdRef = useRef<string | null>(null);
  /**
   * Whether a shape change is outstanding.
   *
   * Both a second change and a build are refused while one is: two amendments
   * would resolve in an unknown order, and a build admitted meanwhile would
   * carry the revision the card held before the change it is racing.
   */
  const [shapeChangePending, setShapeChangePending] = useState(false);
  /** The outstanding change, so a superseded one can be let go of. */
  const shapeChangeAbortRef = useRef<AbortController | null>(null);
  /**
   * How the read that produces `planSnapshot` is going, for the plan it is for.
   *
   * A team plan is built against the revision the card was rendered from, so
   * until that read lands there is nothing safe to build and nothing safe to
   * change. A read that failed used to leave no trace at all: the card looked
   * ordinary, Create was disabled, and the only way out was to describe the
   * team again — throwing away a proposal that was never what failed.
   *
   * Kept against its plan id rather than as a bare flag, so a failure about a
   * plan the card has since replaced simply stops being the current one.
   */
  const [shapeRead, setShapeRead] = useState<
    { planId: string; status: "pending" | "failed"; retrying?: true } | null
  >(null);
  /** The read in flight, so an answer to a superseded one can be let go of. */
  const shapeReadAbortRef = useRef<AbortController | null>(null);
  /** Which read is the current one. A retry makes every earlier one stale. */
  const shapeReadAttemptRef = useRef(0);
  const [buildJob, setBuildJob] = useState<ResourceBuildJobSnapshot | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamedTurn, setStreamedTurn] = useState<StreamedTurn>(
    EMPTY_STREAMED_TURN,
  );
  const activeTurnIdRef = useRef<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const recoveryRef = useRef<ConversationRecovery | null>(null);
  const recoveryAbortRef = useRef<AbortController | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<"checking" | "running" | "unavailable" | null>(null);

  const checkConnection = useCallback(async () => {
    const target = recoveryRef.current;
    if (!target || recoveryAbortRef.current) return;
    const controller = new AbortController();
    recoveryAbortRef.current = controller;
    const ownsRecovery = () => recoveryRef.current === target &&
      activeTurnIdRef.current === target.jobId && !controller.signal.aborted;
    const unavailable = (message = CONNECTION_UNAVAILABLE) => {
      setConnectionStatus("unavailable");
      setError(message);
    };
    setConnectionStatus("checking");
    setError("Connection interrupted. Checking your request…");
    setSubmitting(true);
    try {
      let saved = await readResourceArchitectConversation(controller.signal);
      if (!ownsRecovery()) return;
      if (!matchesConversationRecovery(saved, target)) {
        unavailable();
        return;
      }
      if (saved.turn.status === "running" && !target.deadline.aborted) {
        setConnectionStatus("running");
        setError("Your request is still running. Reconnecting to the reply…");
        // The original reader is already aborted. Resume its cursor so partial
        // text is not replayed, then use the saved status as the authority.
        await openAgentTextStreamAt({
          path: "/create/resource-architect/turn", channelId: target.jobId,
          signal: AbortSignal.any([controller.signal, target.deadline]),
          fromCursor: target.cursor,
          onDelivery: (delivery) => {
            if (!ownsRecovery()) return;
            if ('cursor' in delivery) target.cursor = Math.max(target.cursor, delivery.cursor + 1);
            setStreamedTurn((current) => applyStreamDelivery(current, delivery));
          },
          // A broken preview still needs the authoritative saved-status read.
        }).catch(() => undefined);
        if (!ownsRecovery()) return;
        saved = await readResourceArchitectConversation(controller.signal);
        if (!ownsRecovery()) return;
        if (!matchesConversationRecovery(saved, target)) {
          unavailable();
          return;
        }
      }
      if (saved.turn.status === "running") {
        unavailable("Your request is still running. Check again to reconnect.");
        return;
      }
      setHistory(saved.history);
      setStreamedTurn(EMPTY_STREAMED_TURN);
      setError(saved.turn.status === "completed" ? null : conversationFailureMessage(saved.turn.status));
      setConnectionStatus(null);
      recoveryRef.current = null;
      activeTurnIdRef.current = null;
      setSubmitting(false);
    } catch {
      if (ownsRecovery()) unavailable();
    } finally {
      if (recoveryAbortRef.current === controller) recoveryAbortRef.current = null;
      if (ownsRecovery()) setSubmitting(false);
    }
  }, []);
  const handledTerminalJobsRef = useRef(new Set<string>());
  const lastPublishedEventRef = useRef<{
    jobId: string;
    lastEventId: number;
  } | null>(null);

  const applySnapshot = useCallback(
    async (
      snapshot: ResourceBuildJobSnapshot,
      // False when a restored conversation moved on past this build: its draft
      // already saved the closing message, so the build's end is not announced
      // again and no further draft is started.
      options: { announce?: boolean } = {},
    ) => {
      setBuildJob(snapshot);
      // Unfinished work stays mounted. A build that ended stays readable on
      // this screen, Retry included, but is not carried to the next Create.
      setRetainOnNavigation(isRecoverableResourceBuildJob(snapshot));
      // A receipt says which revision its build was admitted against, and a
      // plan with an admitted build can no longer be amended — whatever became
      // of that build. Reading it here is what settles the card for a build
      // this session started; without it only a restored card knew, and the
      // live one went on offering a change the server refuses.
      if (snapshot.admittedRevision !== undefined) {
        const admitted = {
          jobId: snapshot.jobId,
          revision: snapshot.admittedRevision,
        };
        setPlanSnapshot((current) =>
          // Only ever about the plan the card is showing. A receipt for some
          // other plan says nothing about this one.
          current && current.planId === snapshot.planId
            ? { ...current, admitted }
            : current
        );
      }
      if (snapshot.status === "running") {
        setActiveJobId(snapshot.jobId);
        setSubmitting(true);
        const lastPublished = lastPublishedEventRef.current;
        const lastEventId =
          lastPublished?.jobId === snapshot.jobId
            ? lastPublished.lastEventId
            : 0;
        const publishedEventId = newestPublishedEventId(snapshot.events);
        if (publishedEventId > lastEventId) {
          lastPublishedEventRef.current = {
            jobId: snapshot.jobId,
            lastEventId: publishedEventId,
          };
          try {
            await onResourcesChanged?.();
          } catch {
            // A mid-build sidebar refresh must never abort polling; the
            // terminal refresh reconciles the lists once the build finishes.
          }
        }
        return;
      }

      setActiveJobId(null);
      setSubmitting(false);
      setStopping(false);
      if (handledTerminalJobsRef.current.has(snapshot.jobId)) return;
      handledTerminalJobsRef.current.add(snapshot.jobId);
      if (options.announce !== false) {
        // The build closes with the Architect's own word, so the transcript ends
        // on what was published rather than on a card the user has to interpret.
        const completion = describeCompletedBuild(snapshot);
        if (completion) {
          setHistory((current) => [...current, createTurn("assistant", completion)]);
        }
        if (
          snapshot.status === "completed" ||
          snapshot.status === "partially_completed"
        ) {
          setDraftId(crypto.randomUUID());
        }
      }
      await onResourcesChanged?.();
      if (snapshot.selectedResource) {
        onSelectResource?.(snapshot.selectedResource);
      }
      if (snapshot.status === "failed") {
        setError(snapshot.error ?? "Agent and Team build failed.");
      }
      if (snapshot.status === "interrupted") {
        setError(snapshot.error ?? "Agent and Team build was interrupted. Retry it to continue.");
      }
    },
    [onResourcesChanged, onSelectResource],
  );

  const createPlan = useCallback(
    async (plan = pendingPlan) => {
      if (!plan) return;
      // The snapshot must describe the plan being submitted. A revision read
      // for some other plan is not authority over this one.
      if (planSnapshot && planSnapshot.planId !== plan.id) return;
      // A change is outstanding, so the revision this build would carry is
      // about to be replaced by the one that change returns.
      if (shapeChangePending || shapeChangeAbortRef.current) return;
      // A shaped plan is not built until the revision the card is showing is
      // known. Building in that window sends no revision, which is exactly the
      // stale-card admission the revision exists to refuse — and the shape is
      // the part a concurrent amendment changes.
      if (!planRevision && (hasPlannedWebResearchChoice(plan) || (plan.kind === "team" && plan.team.shape))) return;
      // A saved shape this app cannot build is refused by name, and the card is
      // already saying so. Submitting it spends a round trip to be told what
      // the user is looking at. It becomes buildable when the repair persists:
      // the amendment answers with the plan it wrote, and that plan no longer
      // carries the rejection.
      if (plan.kind === "team" && plan.team.shapeRejected === true) return;
      // Pressing Create is work the user started, like a turn is.
      interactionGenerationRef.current += 1;
      setSubmitting(true);
      setError(null);
      setBuildJob(createPlannedSnapshot(plan));
      try {
        const result = await startResourceBuildJob({
          planId: plan.id,
          draftId,
          // The revision this card was rendered from, so a plan someone
          // amended since is refused rather than silently built.
          ...(planRevision ? { expectedRevision: planRevision } : {}),
          ...chosenPair,
        });
        if (result.cancelled || !result.job) {
          setBuildJob(null);
          setSubmitting(false);
          return;
        }
        await applySnapshot(result.job);
      } catch (caught) {
        setBuildJob(null);
        setError(caught instanceof Error ? caught.message : String(caught));
        setSubmitting(false);
      }
    },
    [
      applySnapshot,
      chosenPair,
      draftId,
      pendingPlan,
      planRevision,
      planSnapshot,
      shapeChangePending,
    ],
  );

  /**
   * Applies a shape the user picked in place of the proposed one.
   *
   * Returns the message to show, when there is one. A refusal is a state the
   * user is in, not a fault: the card is redrawn from what is really stored
   * and the reason is said plainly.
   */
  const changeShape = useCallback(
    async (shape: TeamShape): Promise<string | undefined> => {
      if (!pendingPlan || pendingPlan.kind !== "team" || !planRevision) return undefined;
      if (shapeChangePending) {
        return "This team is already being changed. Wait for that to finish.";
      }
      setShapeChangePending(true);
      const changingPlanId = pendingPlan.id;
      // This call owns the pending flag and the abort handle until it is done.
      // Clearing them unconditionally let a superseded call turn off a state a
      // newer one had set.
      const owned = new AbortController();
      shapeChangeAbortRef.current?.abort();
      shapeChangeAbortRef.current = owned;
      let result: Awaited<ReturnType<typeof changeProposedTeamShape>>;
      try {
        result = await changeProposedTeamShape({
          plan: pendingPlan,
          shape,
          revision: planRevision,
          amend: (request) => amendTeamShape({ ...request, signal: owned.signal }),
        });
      } catch (caught) {
        // The request never reached a verdict, so nothing is known to have
        // changed. The plan on screen is kept as it is and the reason is
        // reported, rather than blanking the card or throwing into an
        // unhandled rejection the user never sees.
        // Reported only to the plan that asked. An old failure painted on a
        // newer plan describes something the user is no longer looking at.
        if (displayedPlanIdRef.current !== changingPlanId) return undefined;
        return caught instanceof Error
          ? `That change could not be saved: ${caught.message}`
          : "That change could not be saved.";
      } finally {
        if (shapeChangeAbortRef.current === owned) {
          shapeChangeAbortRef.current = null;
          setShapeChangePending(false);
        }
      }
      // An answer about a plan the card has since replaced is discarded, for
      // the same reason a late revision read is.
      if (displayedPlanIdRef.current !== changingPlanId) return undefined;
      setPendingPlan(result.plan);
      setPlanSnapshot((current) => ({
        planId: changingPlanId,
        revision: result.revision,
        // Carried forward, and taken from the refusal when that is what said
        // so. A refused change that dropped it left the card offering the
        // change again, against a plan the server has already settled.
        ...(result.admitted
          ? { admitted: result.admitted }
          : current?.planId === changingPlanId && current.admitted
          ? { admitted: current.admitted }
          : {}),
      }));
      return result.notice;
    },
    [pendingPlan, planRevision, shapeChangePending],
  );

  const changeWebResearch = useCallback(async (agentName: string, enabled: boolean): Promise<string | undefined> => {
    if (!pendingPlan || !planRevision || planAdmitted || buildJob || shapeChangeAbortRef.current) return;
    const planId = pendingPlan.id;
    const owned = new AbortController();
    shapeChangeAbortRef.current = owned;
    setShapeChangePending(true);
    try {
      const result = await amendAgentWebResearch({ planId, agentName, enabled, expectedRevision: planRevision, signal: owned.signal });
      if (displayedPlanIdRef.current !== planId || owned.signal.aborted) return;
      setPendingPlan(result.plan);
      setPlanSnapshot((current) => ({
        planId,
        revision: result.revision,
        ...(result.admitted ? { admitted: result.admitted }
          : current?.planId === planId && current.admitted ? { admitted: current.admitted } : {}),
      }));
      return result.notice;
    } catch (caught) {
      if (displayedPlanIdRef.current === planId && !owned.signal.aborted) {
        return caught instanceof Error
          ? `Internet access could not be saved: ${caught.message}`
          : "Internet access could not be saved.";
      }
    } finally {
      if (shapeChangeAbortRef.current === owned) {
        shapeChangeAbortRef.current = null;
        setShapeChangePending(false);
      }
    }
    return undefined;
  }, [pendingPlan, planRevision, planAdmitted, buildJob]);

  /**
   * Reads the revision that describes one plan, and records how it went.
   *
   * The revision and the plan it describes are applied together or not at all:
   * applying half of an answer is how a revision came to describe data nobody
   * was showing. An answer is only applied while it is still the read this card
   * is waiting on — the same plan, and no later read started since — so a slow
   * answer about a plan that has been replaced, or a retry the user abandoned,
   * changes nothing.
   */
  const readPlanShape = useCallback((planId: string, retrying?: true) => {
    shapeReadAbortRef.current?.abort();
    const owned = new AbortController();
    shapeReadAbortRef.current = owned;
    const attempt = shapeReadAttemptRef.current + 1;
    shapeReadAttemptRef.current = attempt;
    const stillMine = (): boolean =>
      displayedPlanIdRef.current === planId &&
      shapeReadAttemptRef.current === attempt &&
      !owned.signal.aborted;
    // A first read in flight is not a failure and is not a retry: the card
    // waits for it and says nothing. Only a read the user asked for again,
    // after one failed, has anything to announce while it is running.
    setShapeRead({ planId, status: "pending", ...(retrying ? { retrying } : {}) });
    void readTeamShape(planId, { signal: owned.signal }).then(
      (current) => {
        if (!stillMine()) return;
        if (current.plan) setPendingPlan(current.plan);
        setPlanSnapshot({
          planId,
          revision: current.revision,
          ...(current.admitted ? { admitted: current.admitted } : {}),
        });
        setShapeRead(null);
      },
      () => {
        if (!stillMine()) return;
        // No revision means nothing trustworthy to build or change against, so
        // the snapshot is cleared rather than left at whatever it held.
        setPlanSnapshot(null);
        setShapeRead({ planId, status: "failed" });
      },
    );
  }, []);

  /**
   * Reads the displayed plan's revision again, on the user's say-so.
   *
   * The proposal itself is not at fault when this read fails, so the way back
   * is to ask again for the same one rather than to describe the team afresh.
   */
  const retryShapeRead = useCallback(() => {
    if (!pendingPlan) return;
    // Scoped before anything is cancelled. A handler left over from a plan the
    // card has since replaced would otherwise abort the read the plan now on
    // screen is waiting on, and leave it waiting for an answer nobody asked
    // for.
    if (displayedPlanIdRef.current !== pendingPlan.id) return;
    readPlanShape(pendingPlan.id, true);
  }, [pendingPlan, readPlanShape]);

  const runTurn = useCallback(
    async function runTurnImpl(
      operation: "conversation" | "proposal",
      turnHistory: ChatTurn[],
      composerSelection: ResourceArchitectComposerSelection,
    ) {
      if (submitting) return;
      recoveryAbortRef.current?.abort();
      recoveryRef.current = null;
      setConnectionStatus(null);
      const turnDeadline = AbortSignal.timeout(RESOURCE_ARCHITECT_TURN_TIMEOUT_MS);
      setRetainOnNavigation(true);
      // Everything the user starts moves this on, so a restore read that began
      // earlier stays stale even after this turn has answered and settled.
      interactionGenerationRef.current += 1;
      const jobId = crypto.randomUUID();
      activeTurnIdRef.current = jobId;
      setSubmitting(true);
      setStopping(false);
      setError(null);

      // Subscribe before posting. The job id is the channel id, so the stream
      // can legitimately open before the turn that fills it exists; the server
      // waits rather than making the client race. Only a conversational turn
      // produces prose — a proposal answers with a card.
      //
      // Whether this turn disclosed on its own. When it did not, the record the
      // server kept is the only place the disclosure can come from.
      let disclosedLive = false;
      // The frame is a preview and can be missed. While this exact turn is
      // still running and has said nothing, the record the server wrote before
      // it called the model is read once as the fallback. Bounded to that
      // turn, so a notice already received is never duplicated or replaced.
      // A turn can open its stream and then wait — reading uploaded document
      // evidence, say — before it resolves a pair at all. A subscription that
      // ends inside that window recovers against a record that does not exist
      // yet, and the frame published afterwards has no listener. So the
      // recovery also listens again, a bounded number of times: it is the turn
      // that ends this, not a timer.
      let remainingResubscribes = MAX_DISCLOSURE_RESUBSCRIBES;
      // Whether this turn has said what it runs on at all, which is not the
      // same question as whether a notice is on screen: an explicit choice is
      // disclosed by saying nothing. Conflating the two makes the recovery
      // chase a notice that is never owed.
      let selectionSeen = false;
      // One reader at a time. A reset says frames were lost, not that the
      // reader is gone, and a second reader beside a live one makes every
      // later delta arrive twice.
      let readerActive = false;
      // Where this turn has already been read to, so listening again resumes
      // rather than replays.
      let nextCursor = 0;
      const recoverMissedDisclosure = async (): Promise<void> => {
        if (activeTurnIdRef.current !== jobId || selectionSeen || streamAbort.signal.aborted) return;
        await reconcileRecordedSelections();
        if (activeTurnIdRef.current !== jobId || selectionSeen || streamAbort.signal.aborted) return;
        if (readerActive || remainingResubscribes <= 0) return;
        remainingResubscribes -= 1;
        subscribe();
      };
      const streamAbort = new AbortController();
      streamAbortRef.current?.abort();
      streamAbortRef.current = streamAbort;
      setStreamedTurn(EMPTY_STREAMED_TURN);
      // Opened for every operation, not only a streaming one. A proposal
      // publishes no prose — its answer is a card, not text — but it uses a
      // model exactly as a conversation does and owes the same disclosure
      // while it runs.
      function subscribe(): void {
      readerActive = true;
      void openAgentTextStreamAt({
        path: "/create/resource-architect/turn",
        channelId: jobId,
        signal: streamAbort.signal,
        fromCursor: nextCursor,
        onDelivery: (delivery) => {
          // A subscription the hook has moved on from paints nothing.
          if (activeTurnIdRef.current !== jobId || streamAbort.signal.aborted) return;
          if ('cursor' in delivery) {
            nextCursor = Math.max(nextCursor, delivery.cursor + 1);
          }
          if (delivery.type === "selection") {
            selectionSeen = true;
            // Published after the server recorded the pair and before it called
            // the model, so this is the notice a person sees while a slow or
            // gated provider is still working. The durable record remains the
            // authority; losing this frame costs the live notice only.
            const selection = delivery.selection;
            if (selection.source !== "app-default") return;
            disclosedLive = true;
            const id = `architect-model-selection:${jobId}`;
            setModelSelections((current) =>
              current.some((entry) => entry.id === id)
                ? current
                : [
                    ...current,
                    {
                      id,
                      occurredAt: new Date().toISOString(),
                      jobId,
                      operation,
                      selection,
                    },
                  ],
            );
            return;
          }
          if (delivery.type === "reset") {
            // The retained window moved past a frame this subscriber never
            // saw, so the disclosure may be one of the frames it lost.
            void recoverMissedDisclosure();
          }
          if (operation !== "conversation") return;
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
      }
      subscribe();

      try {
        const result = await postResourceArchitectTurn({
          jobId,
          operation,
          history: turnHistory,
          currentPlan: pendingPlan,
          selectedResource: selectedResource ?? restoredSelectionRef.current ?? undefined,
          draftId,
          documentReader:
            documentReader.provider && documentReader.model
              ? documentReader
              : undefined,
          provider: composerSelection.provider,
          model: composerSelection.model,
          composerSelection,
        });
        if (activeTurnIdRef.current !== jobId) return;
        if ("cancelled" in result) {
          setHistory((current) => [...current, createTurn("assistant", "Generation stopped.")]);
          return;
        }
        liveReviewWarningsRef.current.add(jobId);
        setRestoredReviewNotices((current) => current.filter((entry) => entry.jobId !== jobId));
        const reviewWarnings = result.meta.review ? resourceArchitectReviewWarnings(result.meta.review) : [];
        const assistantTurn = createTurn(
          "assistant",
          formatArchitectResponse(result.message, [...new Set([...result.warnings, ...reviewWarnings])]),
        );
        setHistory((current) => [...current, assistantTurn]);
        const selection = result.meta.selection;
        if (selection?.source === "app-default") {
          disclosedLive = true;
          const id = `architect-model-selection:${jobId}`;
          setModelSelections((current) =>
            current.some((entry) => entry.id === id)
              ? current
              : [
                  ...current,
                  {
                    id,
                    occurredAt: assistantTurn.createdAt,
                    jobId,
                    operation: result.operation,
                    selection,
                  },
                ],
          );
        }
        setDocumentUploadRevision((current) => current + 1);
        if (result.operation === "proposal") {
          const outcome = result.outcome;
          if (
            outcome.kind === "standalone_agents" ||
            outcome.kind === "team" ||
            outcome.kind === "resource_updates"
          ) {
            setPendingPlan(outcome);
            setPendingPlanCreatedAt(assistantTurn.createdAt);
            setBuildJob(null);
            setPlanSnapshot(null);
            displayedPlanIdRef.current = outcome.id;
            // A change to the plan being replaced has nothing left to apply.
            shapeChangeAbortRef.current?.abort();
            shapeChangeAbortRef.current = null;
            setShapeChangePending(false);
            readPlanShape(outcome.id);
          } else if (outcome.kind === "edit_existing") {
            onSelectResource?.(outcome.target);
          }
        }
        if (result.meta.fallback) {
          setError(result.meta.reason ?? "Agent Architect is offline.");
        }
        if (result.operation === "conversation" && result.proposalRequested === true) {
          await runTurnImpl("proposal", [...turnHistory, assistantTurn], composerSelection);
          return;
        }
      } catch (caught) {
        if (activeTurnIdRef.current === jobId) {
          if (operation === "conversation" && caught instanceof ResourceArchitectConnectionError) {
            streamAbort.abort();
            recoveryRef.current = { draftId, jobId, cursor: nextCursor, deadline: turnDeadline };
            await checkConnection();
          } else {
            setError(caught instanceof Error ? caught.message : String(caught));
          }
        }
      } finally {
        // A model may already have run for this turn even though nothing was
        // disclosed live: the server refused to materialize a proposal after
        // generating it, or the person stopped the turn and handed its
        // ownership away, so the settling reply paints nothing. Either way the
        // disclosure is owed and is read back from what the server recorded.
        //
        // Never awaited. This is a recovery read, and waiting on it would let
        // a stalled history request hold an already-finished composer shut.
        if (!disclosedLive) void reconcileRecordedSelections();
        streamAbort.abort();
        if (activeTurnIdRef.current === jobId && recoveryRef.current?.jobId !== jobId) {
          // Cleared here rather than when the reply is appended: the bubble and
          // the saved turn must not both be on screen for a frame.
          setStreamedTurn(EMPTY_STREAMED_TURN);
          activeTurnIdRef.current = null;
          setSubmitting(false);
          setStopping(false);
        }
      }
    },
    [
      documentReader,
      draftId,
      onSelectResource,
      pendingPlan,
      readPlanShape,
      reconcileRecordedSelections,
      selectedResource,
      submitting,
      checkConnection,
    ],
  );

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || submitting || recoveryRef.current || !chosenProvider || !chosenModel) return;
      const composerSelection: ResourceArchitectComposerSelection = Object.freeze({
        provider: chosenProvider,
        model: chosenModel,
        origin: modelOrigin,
      });
      const nextHistory = [...history, createTurn("user", trimmed)];
      setHistory(nextHistory);
      await runTurn("conversation", nextHistory, composerSelection);
    },
    [chosenModel, chosenProvider, history, modelOrigin, runTurn, submitting],
  );

  /**
   * Throws away the unfinished Team the current build left behind.
   *
   * The shell is not a team anybody can use and nothing lists it, so this is
   * the only way to remove it. The receipt that comes back records the
   * decision, which is what stops a later reopen offering to finish it.
   */
  const discard = useCallback(async () => {
    if (!buildJob || buildJob.status === "running") return;
    setError(null);
    try {
      await applySnapshot(await discardResourceBuildTeam(buildJob.jobId));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `That could not be discarded: ${caught.message}`
          : "That could not be discarded.",
      );
    }
  }, [applySnapshot, buildJob]);

  const retry = useCallback(async () => {
    if (!buildJob || buildJob.status === "running") return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await retryResourceBuildJob({
        jobId: buildJob.jobId,
        draftId,
        ...chosenPair,
      });
      if (!result.cancelled && result.job) await applySnapshot(result.job);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSubmitting(false);
    }
  }, [applySnapshot, buildJob, chosenPair, draftId]);

  const stop = useCallback(async () => {
    const turnJobId = activeTurnIdRef.current;
    const buildJobId = turnJobId ? null : activeJobId;
    const jobId = turnJobId ?? buildJobId;
    if (!jobId || stopping) return;
    setStopping(true);

    // Torn down before the cancel is awaited, never after. Stop is a direct
    // instruction, and the request that carries it can be slow or never answer
    // at all; waiting on it would leave half a reply on screen and let the
    // abandoned turn keep painting into it. Ownership is handed away here too,
    // so the turn's own cleanup will skip it.
    activeTurnIdRef.current = null;
    recoveryAbortRef.current?.abort();
    recoveryRef.current = null;
    setConnectionStatus(null);
    setError(null);
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setStreamedTurn(EMPTY_STREAMED_TURN);
    if (!buildJobId) {
      setActiveJobId(null);
      setSubmitting(false);
    }

    try {
      await cancelAgentJob(jobId);
      if (buildJobId) {
        await applySnapshot(await readResourceBuildJob(buildJobId));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStopping(false);
    }
  }, [activeJobId, applySnapshot, stopping]);

  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    let timeoutId: number | undefined;
    let nextReconciliationAt = Date.now() + RECONCILIATION_POLL_INTERVAL_MS;
    const poll = async () => {
      try {
        let snapshot = await readResourceBuildJob(activeJobId);
        if (
          snapshot.status === "running" &&
          Date.now() >= nextReconciliationAt
        ) {
          nextReconciliationAt = Date.now() + RECONCILIATION_POLL_INTERVAL_MS;
          const reconciledSnapshot = await listResourceBuildJobs()
            .then((jobs) => jobs.find((job) => job.jobId === activeJobId))
            .catch(() => undefined);
          if (reconciledSnapshot) {
            snapshot = reconciledSnapshot;
          }
        }
        if (cancelled) return;
        await applySnapshot(snapshot);
        if (snapshot.status === "running") {
          timeoutId = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setActiveJobId(null);
        setSubmitting(false);
      }
    };
    timeoutId = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [activeJobId, applySnapshot]);

  // Reopening Create puts back the build that was left unfinished.
  //
  // Running, interrupted and partially completed builds retain their recovery
  // controls. A build that ended (completed, failed, cancelled, or discarded)
  // leaves a fresh chat when Create reopens; its receipt stays on disk.
  /**
   * How many times the user has started something since Create opened.
   *
   * A restore reads the server, and that read can answer at any time — while
   * the new work is still running, or long after it has finished. Asking "is
   * anything running now" answers the first case and not the second: by then
   * the turn has settled and its marker is clear again, and a conversational
   * reply leaves no plan behind for the read to disagree with. So the read
   * carries the count it started at, and anything the user began since makes
   * it stale for good.
   */
  const interactionGenerationRef = useRef(0);
  /**
   * Whether anything newer than a stopped build is already on screen, in
   * flight, or has happened since `startedAt`.
   */
  const busyWithNewerWork = useCallback(
    (startedAt?: number) =>
      (startedAt !== undefined &&
        interactionGenerationRef.current !== startedAt) ||
      displayedPlanIdRef.current !== null ||
      activeTurnIdRef.current !== null ||
      activeJobId !== null ||
      buildJob !== null ||
      pendingPlan !== null,
    [activeJobId, buildJob, pendingPlan],
  );

  useEffect(() => {
    // Restoration belongs to opening Create, before the user has done
    // anything. Once they have started something — even something that has
    // since finished — there is nothing left to restore over, and a read that
    // began again at that point would read the interaction count as it now
    // stands and no longer see the conversation it must not overwrite.
    //
    // Engagement, not "this effect has run": React mounts twice in
    // development, and the first mount's cleanup cancels the read it started.
    // A flag that never resets would leave the second mount with nothing.
    if (interactionGenerationRef.current > 0) return;
    let cancelled = false;
    const recoveryStream = new AbortController();
    void (async () => {
      // Nothing is restored over work the user has already started. A turn in
      // flight has no plan yet, so checking only for a displayed plan left a
      // window: a slow read could still land and clear the submitting state
      // underneath a request that had not answered.
      if (busyWithNewerWork()) return;
      // Where this restore started. Anything the user begins after this makes
      // every answer below stale, whether it is still running or not.
      const startedAt = interactionGenerationRef.current;
      let conversation: Awaited<ReturnType<typeof readResourceArchitectConversation>>;
      try {
        conversation = await readResourceArchitectConversation();
      } catch (caught) {
        if (!cancelled && !busyWithNewerWork(startedAt)) {
          setError(caught instanceof Error ? caught.message : "The saved Create conversation could not be restored.");
        }
        return;
      }
      if (cancelled || busyWithNewerWork(startedAt)) return;
      if (conversation) {
        setDraftId(conversation.draftId);
        setHistory(conversation.history);
        setRetainOnNavigation(true);
        restoredSelectionRef.current = conversation.selectedResource;
        if (conversation.documentReader) setDocumentReader(conversation.documentReader);
        // A renderer reload can reconnect to a running backend. A full app
        // restart reports interrupted instead, so it never shows a false Stop.
        if (conversation.turn.status === "running") {
          const jobId = conversation.turn.jobId;
          activeTurnIdRef.current = jobId;
          streamAbortRef.current = recoveryStream;
          setSubmitting(true);
          setRestoring(false);
          await openAgentTextStreamAt({
            path: "/create/resource-architect/turn", channelId: jobId,
            signal: AbortSignal.any([recoveryStream.signal, AbortSignal.timeout(RESOURCE_ARCHITECT_TURN_TIMEOUT_MS)]),
            onDelivery: (delivery) => {
              if (!cancelled && activeTurnIdRef.current === jobId) setStreamedTurn((current) => applyStreamDelivery(current, delivery));
            },
          });
          if (cancelled || activeTurnIdRef.current !== jobId) return;
          const settled = await readResourceArchitectConversation();
          if (cancelled || activeTurnIdRef.current !== jobId) return;
          activeTurnIdRef.current = null;
          setSubmitting(false);
          setStreamedTurn(EMPTY_STREAMED_TURN);
          if (!settled || settled.draftId !== conversation.draftId) return;
          conversation = settled;
          setHistory(settled.history);
        }
        if (conversation.turn.status === "interrupted") {
          setError("The app closed before the last reply finished. Your conversation was restored; send a message to continue.");
        }
        if (conversation.planId) {
          const snapshot = await readTeamShape(conversation.planId);
          const jobs = await listResourceBuildJobs();
          if (cancelled || interactionGenerationRef.current !== startedAt) return;
          const newest = newestResourceBuildJob(jobs.filter((entry) => entry.planId === snapshot.planId));
          // The conversation went on after this plan's build ended, and let go
          // of that build when the next message was admitted. A plan an ended
          // build consumed is not offered again; the messages are what remain.
          if (!conversation.buildJobId && newest && !isRecoverableResourceBuildJob(newest)) return;
          displayedPlanIdRef.current = snapshot.planId;
          setPendingPlan(snapshot.plan);
          setPendingPlanCreatedAt(conversation.updatedAt);
          setPlanSnapshot({ planId: snapshot.planId, revision: snapshot.revision, ...(snapshot.admitted ? { admitted: snapshot.admitted } : {}) });
          setRestoring(false);
          // The build as it stands now. It can have ended after the
          // conversation route read it; the card then says how, and the screen
          // is not kept for the next visit. A conversation that does not name
          // its plan's build gets it back too: past the return above, that
          // build is unfinished, and without it the card offers a Create the
          // server refuses.
          if (newest) await applySnapshot(newest, { announce: conversation.buildJobId !== null });
        }
        return;
      }
      const jobs = await listResourceBuildJobs().catch(() => null);
      // A server from before unified resource jobs should not break Create.
      if (!jobs || cancelled || busyWithNewerWork(startedAt)) return;
      const restorable = restorableResourceBuildJob(jobs);
      if (!restorable) {
        // The latest attempt ended, so it is a barrier: Create opens clean and
        // no older attempt comes back from behind it. Its old diagnostics stay
        // cleared too, even when their recovery read lands after this one.
        if (jobs.length > 0) {
          suppressRestoredConversationRef.current = true;
          setHistory([]);
          setModelSelections([]);
          setRestoredReviewNotices([]);
        }
        return;
      }
      // The plan, the revision that describes it and the build it was admitted
      // for, read together from the server. The page remembers none of this
      // across a reload, and half of it would put a revision against data
      // nobody is showing.
      const snapshot = await readTeamShape(restorable.planId).catch(() => null);
      if (cancelled || !snapshot) return;
      // Work started while this read was outstanding is newer than the record
      // of a build that has already stopped. The newer work stands.
      if (busyWithNewerWork(startedAt)) return;
      displayedPlanIdRef.current = snapshot.planId;
      setPendingPlan(snapshot.plan);
      setPendingPlanCreatedAt(restorable.startedAt ?? null);
      setPlanSnapshot({
        planId: snapshot.planId,
        revision: snapshot.revision,
        ...(snapshot.admitted ? { admitted: snapshot.admitted } : {}),
      });
      await applySnapshot(restorable);
    })().catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "The saved Create conversation could not be restored.");
    }).finally(() => {
      if (!cancelled) setRestoring(false);
    });
    return () => {
      cancelled = true;
      recoveryStream.abort();
    };
  }, [activeJobId, applySnapshot, buildJob, busyWithNewerWork, pendingPlan]);

  // Rebuilt from the turn records the server kept, once, when Create opens.
  // A reload must not take a disclosure away: the record of how a turn chose
  // its model outlives the page, and this is where it comes back. Only default
  // use is restored, for the same reason it is the only thing disclosed live.
  useEffect(() => {
    void reconcileRecordedSelections();
  }, [reconcileRecordedSelections]);



  useEffect(
    () => () => {
      recoveryAbortRef.current?.abort();
      recoveryRef.current = null;
      activeTurnIdRef.current = null;
      streamAbortRef.current?.abort();
      shapeReadAbortRef.current?.abort();
    },
    [],
  );

  return {
    history,
    restoring,
    // Anything in flight keeps Create mounted. Otherwise the build on screen
    // decides: unfinished work stays, and a build that ended stays readable
    // here, Retry included, without being kept for the next visit. Decided
    // from the build as it stands now, so a reply over an ended build lets it
    // go however that reply ends, Stop included, and never lets go of a build
    // retried while it ran. The conversation itself comes back from disk.
    retainOnNavigation: submitting ||
      (buildJob ? isRecoverableResourceBuildJob(buildJob) : retainOnNavigation),
    modelSelections,
    restoredReviewNotices,
    draftId,
    documentReader,
    documentUploadRevision,
    pendingPlan,
    pendingPlanCreatedAt,
    buildJob,
    submitting,
    stopping,
    error,
    connectionStatus,
    checkConnection,
    streamedTurn,
    setDocumentReader,
    clearRestoredSelection,
    submit,
    createPlan,
    changeShape,
    changeWebResearch,
    planRevision,
    planAdmitted,
    // A plan with an admitted build has been built against already — there is
    // a team on disk that its shape describes — so the shape is settled and the
    // control is not offered.
    canChangeShape: planRevision !== null && !shapeChangePending &&
      planAdmitted === null,
    shapeChangePending,
    // Only ever about the plan on screen. A failure recorded for a plan that
    // has since been replaced is not this card's to report.
    shapeReadFailed: shapeRead?.status === "failed" &&
      shapeRead.planId === pendingPlan?.id,
    // A read the user asked for again, still running. The first read of a plan
    // is not this: nothing has failed, so there is nothing to say about it.
    shapeReadRetrying: shapeRead?.status === "pending" &&
      shapeRead.retrying === true && shapeRead.planId === pendingPlan?.id,
    retryShapeRead,
    retry,
    discard,
    stop,
  };
}

function matchesConversationRecovery(
  saved: ResourceArchitectConversation | null,
  target: ConversationRecovery,
): saved is ResourceArchitectConversation {
  return saved !== null && saved.draftId === target.draftId &&
    saved.turn.jobId === target.jobId && saved.turn.operation === "conversation";
}

function conversationFailureMessage(status: "failed" | "cancelled" | "interrupted"): string {
  switch (status) {
    case "failed": return "The request failed. Your message is still here. You can send it again.";
    case "cancelled": return "The request was cancelled. Your message is still here.";
    case "interrupted": return "The app stopped before the reply finished. Your message is still here. You can send it again.";
  }
}

/** How many recorded turns a reopened Create reads back. */
const RECORDED_SELECTION_LIMIT = 50;
/**
 * How many times one turn will listen again after its stream ends early.
 *
 * Bounded rather than open-ended: a turn that keeps losing its subscription
 * still stops asking, and the reply itself remains the backstop.
 */
const MAX_DISCLOSURE_RESUBSCRIBES = 3;
/** A recovery read is bounded; a turn never waits on it. */
const RECONCILIATION_TIMEOUT_MS = 10_000;


const DEFAULT_DOCUMENT_READER: ModelChoice = { provider: "", model: "" };

function newestPublishedEventId(events: ResourceBuildEvent[]): number {
  return events.reduce(
    (max, event) =>
      PUBLISHED_RESOURCE_EVENT_TYPES.has(event.type) && event.id > max
        ? event.id
        : max,
    0,
  );
}

function describeCompletedBuild(snapshot: ResourceBuildJobSnapshot): string | null {
  if (
    snapshot.status !== "completed" &&
    snapshot.status !== "partially_completed"
  ) {
    return null;
  }

  const updated = snapshot.items.filter((item) => item.status === "updated");
  if (updated.length > 0) return describeCompletedUpdate(snapshot, updated);

  const teamItem = snapshot.items.find(
    (item) => item.plannedResource.kind === "team",
  );
  if (teamItem) {
    if (teamItem.status !== "created" && teamItem.status !== "reused") return null;
    const teamId = teamItem.resource?.id ?? teamItem.plannedResource.id;
    const created = distinctAgentIds(snapshot.events, "agent_created").size;
    const reused = distinctAgentIds(snapshot.events, "agent_reused").size;
    const roster = distinctAgentIds(snapshot.events, "agent_added").size;
    const composition = [
      created > 0 ? `${created} created` : null,
      reused > 0 ? `${reused} reused` : null,
    ].filter((part) => part !== null).join(", ");
    const rosterSentence = roster > 0
      ? ` Its roster holds ${roster} ${roster === 1 ? "Agent" : "Agents"}${
        composition ? ` (${composition})` : ""
      }.`
      : "";
    return snapshot.status === "completed"
      ? `Done — Team \`${teamId}\` is ready.${rosterSentence} You will find it in the Teams list in the left sidebar.`
      : `Team \`${teamId}\` is created, but not every planned Agent finished.${rosterSentence} Use Retry on the card above to complete the rest.`;
  }

  const published = snapshot.items.filter(
    (item) => item.status === "created" || item.status === "reused",
  );
  if (published.length === 0) return null;
  const names = published
    .map((item) => `\`${item.resource?.id ?? item.plannedResource.id}\``)
    .join(", ");
  const label = published.length === 1 ? "Agent is" : "Agents are";
  return snapshot.status === "completed"
    ? `Done — ${published.length} ${label} ready: ${names}. You will find ${
      published.length === 1 ? "it" : "them"
    } in the Agents list in the left sidebar.`
    : `${published.length} of ${snapshot.items.length} planned Agents are ready: ${names}. Use Retry on the card above to complete the rest.`;
}

/**
 * An update never says "created": the resource already existed, and the user
 * needs to read what changed about something they already know.
 *
 * One plan can update Teams, Agents, or both, and the three read differently.
 * A roster sentence belongs only to a plan that changed a Team — an Agent
 * whose skills were rewritten did not join anything — and the sidebar list the
 * user should look in follows the kinds of target that actually changed.
 */
function describeCompletedUpdate(
  snapshot: ResourceBuildJobSnapshot,
  updated: ResourceBuildJobSnapshot["items"],
): string {
  const teams = updated.filter((item) => updatedRef(item).kind === "team");
  const agents = updated.filter((item) => updatedRef(item).kind === "agent");
  const subject = [
    describeUpdatedTargets(teams, "Team", "Teams"),
    describeUpdatedTargets(agents, "Agent", "Agents"),
  ].filter((part) => part !== null).join(" and ");

  const added = countOperationScopedAgents(snapshot.events, "agent_added");
  const rosterSentence = teams.length > 0 && added > 0
    ? ` ${added} ${added === 1 ? "Agent is" : "Agents are"} now on the roster.`
    : "";

  if (snapshot.status === "completed") {
    return `Done — ${subject} updated.${rosterSentence}${describeWhereToLook(teams.length, agents.length)}`;
  }
  // Two ways this plan is finished whatever it does next. A revision it pinned
  // is gone, or it names an Agent whose name it cannot have — either way the
  // plan carries the value that does not work, and the reason has to be the
  // real one rather than whichever is easier to say.
  const conflicted = snapshot.events.some(
    (event) => event.type === "resource_update_conflict",
  );
  const needsInput = snapshot.events.some(
    (event) => event.type === "agent_needs_input",
  );
  const remedy = conflicted
    ? " Ask for a fresh proposal — the change that did not finish was pinned to a revision that has since moved on, so retrying this plan cannot succeed."
    : needsInput
      // Deliberately general: the builder raises this for any Agent it cannot
      // draft from the plan — an unavailable name, a brief that needs more
      // detail — and naming only one of those would be a guess.
      ? " Ask for a fresh proposal — this plan does not carry enough to create one of its Agents, so retrying it cannot succeed."
      : " Use Retry on the card above to complete the rest.";
  return `${subject} updated, but not every requested change finished.${rosterSentence}${remedy}`;
}

function updatedRef(
  item: ResourceBuildJobSnapshot["items"][number],
): CreateResourceRef {
  return item.resource ?? item.plannedResource;
}

function describeUpdatedTargets(
  items: ResourceBuildJobSnapshot["items"],
  singular: string,
  plural: string,
): string | null {
  if (items.length === 0) return null;
  const names = items.map((item) => `\`${updatedRef(item).id}\``).join(", ");
  return `${items.length === 1 ? singular : plural} ${names}`;
}

function describeWhereToLook(teamCount: number, agentCount: number): string {
  if (teamCount > 0 && agentCount === 0) {
    return " You will find the change in the Teams list in the left sidebar.";
  }
  if (agentCount > 0 && teamCount === 0) {
    return " You will find the change in the Agents list in the left sidebar.";
  }
  return " You will find the changes in the left sidebar.";
}

/**
 * How many distinct memberships an event type reports, per operation.
 *
 * The pair is `(operation, Agent)`, not the Agent alone: one plan may add the
 * same library Agent to two Teams, and that is two memberships. Counting the
 * id on its own would report one. A retry replays its operation, so the same
 * pair arriving twice is still one membership.
 *
 * The Agent an update event is about is named in `resource`; the operation was
 * planned against its target, so `plannedResource` is read only when it is
 * itself an Agent, which is the shape the planned-Agent builder emits.
 */
function countOperationScopedAgents(
  events: ResourceBuildEvent[],
  type: ResourceBuildEvent["type"],
): number {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== type) continue;
    const agentId = event.resource?.kind === "agent"
      ? event.resource.id
      : event.plannedResource?.kind === "agent"
        ? event.plannedResource.id
        : null;
    if (agentId === null) continue;
    seen.add(`${event.planIndex ?? "unscoped"}:${agentId}`);
  }
  return seen.size;
}

function distinctAgentIds(
  events: ResourceBuildEvent[],
  type: ResourceBuildEvent["type"],
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== type || event.plannedResource?.kind !== "agent") continue;
    ids.add(event.plannedResource.id);
  }
  return ids;
}

function formatArchitectResponse(message: string, warnings: string[]): string {
  if (warnings.length === 0) return message;
  return `${message}\n\nContext notes:\n${warnings
    .map((warning) => `- ${warning}`)
    .join("\n")}`;
}

function createTurn(role: ChatTurn["role"], text: string): ChatTurn & { createdAt: string } {
  return { role, text, createdAt: new Date().toISOString() };
}

function createPlannedSnapshot(plan: ResourceArchitectPlan): ResourceBuildJobSnapshot {
  return {
    jobId: `planned:${plan.id}`,
    planId: plan.id,
    status: "running",
    items: createPlannedItems(plan),
    selectedResource: null,
    events: [],
  };
}

function createPlannedItems(
  plan: ResourceArchitectPlan,
): ResourceBuildJobSnapshot["items"] {
  if (plan.kind === "standalone_agents") {
    return plan.agents.map((agent, planIndex) => ({
      plannedResource: { kind: "agent", id: agent.name },
      planIndex,
      status: "planned",
    }));
  }
  if (plan.kind === "team") {
    return [{
      plannedResource: { kind: "team", id: plan.team.teamId },
      planIndex: 0,
      status: "planned",
    }];
  }
  return plan.operations.map((operation, planIndex) => ({
    plannedResource: operation.target,
    planIndex,
    status: "planned",
  }));
}
