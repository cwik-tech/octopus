import { isTerminalResearchActivityState } from "@/lib/clients/research-activity-client";
import type { ResearchActivity } from "@/lib/clients/research-activity-client";
import type { ChatMessage } from "@/lib/models/session-model";
import type { ModelSelectionRecord } from "@contracts/agent-model-selection";
import type { ModelChoiceOffer } from "@contracts/model-choice";
import type {
  ConversationTurnOutcome,
  SessionTitleAttempt,
} from "@contracts/sessions";

/**
 * Whether a research group has stopped working.
 *
 * Deliberately derived from the group's own steps and nothing else. Session-wide
 * turn state carries no run identity, so using it would flip every older group
 * back to unfinished the moment any new turn started, reopening disclosures the
 * user had already watched close.
 */
export function isResearchGroupFinished(
  activities: readonly ResearchActivity[],
): boolean {
  return activities.every((activity) =>
    isTerminalResearchActivityState(activity.state));
}

export type ConversationTimelineItem =
  | {
      readonly kind: "message";
      readonly message: ChatMessage;
      readonly researchActivities: readonly ResearchActivity[];
      readonly order: number;
    }
  | {
      readonly kind: "turn-outcome";
      readonly outcome: ConversationTurnOutcome;
      /** The question this outcome is about, so the card can offer its retry. */
      readonly userMessage: ChatMessage;
      readonly order: number;
    }
  | {
      readonly kind: "model-selection";
      /** The question whose turn admitted these selections. */
      readonly userMessage: ChatMessage;
      readonly selections: readonly {
        readonly speaker: string;
        readonly selection: ModelSelectionRecord;
      }[];
      readonly order: number;
    }
  | {
      /**
       * A selection the session recorded that no message can be hung on.
       *
       * A Team launch made through the API entry persists its brief without a
       * turn, so nothing in the transcript identifies it. The record is still an
       * account of a model that really was used, and a session opened later has
       * to be able to show it — dropping it loses the disclosure, and picking
       * some nearby message to hang it on would put it somewhere it does not
       * belong. So it is placed by its own time and belongs to the session.
       */
      readonly kind: "session-model-selection";
      readonly selections: readonly {
        readonly speaker: string;
        readonly selection: ModelSelectionRecord;
        readonly attemptId: string;
      }[];
      /** When the selection was recorded, so it sorts into the conversation. */
      readonly at: string;
      readonly order: number;
    }
  | {
      readonly kind: "model-choice";
      /** The question whose attempt failed. */
      readonly userMessage: ChatMessage;
      readonly offer: ModelChoiceOffer;
      readonly order: number;
    }
  | {
      readonly kind: "research-group";
      readonly runId: string;
      readonly agentPath: string;
      readonly researchActivities: readonly ResearchActivity[];
      readonly order: number;
    };

/**
 * What this projection needs to know about a task.
 *
 * Only the identity and the turn it came from. Narrow on purpose: a timeline is
 * not a task view, and asking for the whole record would invite it to become
 * one.
 */
export interface TimelineTask {
  readonly id: string;
  readonly sourceTurn?: { readonly turnId: string } | undefined;
}

/**
 * What each of these operations was naming.
 *
 * Three of them name the session; one names the result file a scheduled run
 * will write. Reporting the latter as a session title would describe work that
 * did not happen, so the notice says which it was.
 */
function namedThingFor(operation: SessionTitleAttempt["operation"]): string {
  return operation === "scheduled-filename" ? "artifact filename" : "session title";
}

/**
 * A model one of the application's own background helpers ran on.
 *
 * Naming a delegated job, compressing a discussion and writing a run's minutes
 * are all work that owns no Agent. Each is keyed by what it belongs to rather
 * than by any agent — attributing one to a participant would say a member ran
 * on a model it never used — and each says which helper it was, because "the
 * app default was used" is not an account of anything on its own.
 */
export interface HelperModelSelection {
  /** What this account belongs to: a delegation, or a run's own helper turn. */
  readonly key: string;
  /** What the notice calls it, such as `job title` or `context compression`. */
  readonly speaker: string;
  readonly selection: ModelSelectionRecord;
  /** When the account was recorded, so it sorts into the conversation. */
  readonly at: string;
}

/** The title operations a chat turn can own. */
const CHAT_TITLE_OPERATIONS: ReadonlySet<SessionTitleAttempt["operation"]> = new Set([
  "selected-agent-chat",
  "session-chat",
]);

export function buildConversationTimeline(
  messages: ChatMessage[],
  activities: ResearchActivity[],
  outcomes: readonly ConversationTurnOutcome[] = [],
  modelChoices: readonly ModelChoiceOffer[] = [],
  /**
   * What this session recorded about naming itself.
   *
   * Session-owned rather than carried on a message, because the title is
   * decided after the turn's own record is written and two of the operations
   * that title things have no chat turn at all.
   */
  titleAttempts: readonly SessionTitleAttempt[] = [],
  /**
   * The session's own tasks, so a Team launch can find the brief it belongs to.
   *
   * A launch records its attempt against the task it admitted, and only the
   * task knows which turn asked for it. Without these the owner is an id this
   * projection cannot resolve, and the notice has nowhere to go.
   */
  tasks: readonly TimelineTask[] = [],
  /**
   * What each of this run's own background helpers ran on, when one did.
   *
   * These come from the run's own journal rather than from the session's
   * record: they happen in the team runtime, where there is no session store
   * and no chat turn. One per key — the same helper turn reported twice is one
   * account of one model use.
   */
  helperSelections: readonly HelperModelSelection[] = [],
): ConversationTimelineItem[] {
  // Only the operations whose owner really is a chat turn. A Team launch owns
  // an admitted task and a schedule owns a fire, and matching those ids against
  // turn ids would hang a notice on whichever turn happened to share a string.
  // Those callers get their own placement; that is why this record lives on the
  // session rather than on a turn.
  const titleAttemptsByTurn = new Map<string, SessionTitleAttempt[]>();
  const addTo = (
    index: Map<string, SessionTitleAttempt[]>,
    key: string,
    attempt: SessionTitleAttempt,
  ): void => {
    const existing = index.get(key);
    if (existing) existing.push(attempt);
    else index.set(key, [attempt]);
  };
  for (const attempt of titleAttempts) {
    if (!CHAT_TITLE_OPERATIONS.has(attempt.operation)) continue;
    addTo(titleAttemptsByTurn, attempt.owner, attempt);
  }
  // A Team launch is resolved rather than matched: its owner names a task, that
  // task records the turn it came from, and that turn is a question somebody
  // really asked in this transcript. Every hop is a record something wrote, and
  // the last hop is checked rather than assumed — a message that predates turn
  // identities is looked up by its own id, so a launch resolved only as far as a
  // turn could otherwise land on an older line whose id happens to read like
  // one. Anything short of the whole chain stays unanchored, because a task id
  // and a turn id are different kinds of identity and a shared string is a
  // coincidence, not a fact.
  const turnIdByTask = new Map(
    tasks
      .filter((task) => task.sourceTurn !== undefined)
      .map((task) => [task.id, task.sourceTurn?.turnId ?? ""]),
  );
  //
  // Kept in its own index rather than shared with the chat callers. Theirs is
  // read with `turnId ?? id`, because a generic chat turn may have no turn
  // identity at all — and a Team attempt put in that index would also be found
  // under a message *id*, so one launch could be disclosed twice: once on the
  // brief it belongs to and once on an older line whose id reads like a turn.
  const teamAttemptsByTurn = new Map<string, SessionTitleAttempt[]>();
  const askedTurnIds = new Set(
    messages
      .filter((message) => message.role === "user" && message.turnId !== undefined)
      .map((message) => message.turnId),
  );
  const unanchoredLaunches: SessionTitleAttempt[] = [];
  for (const attempt of titleAttempts) {
    // A scheduled fire names its result file before it admits anything, so it
    // has neither a turn nor a task — only the session it belongs to, which is
    // what a person opens later. It goes straight to the session's own place.
    if (attempt.operation === "scheduled-filename") {
      unanchoredLaunches.push(attempt);
      continue;
    }
    if (attempt.operation !== "team-launch") continue;
    const turnId = turnIdByTask.get(attempt.owner);
    if (turnId && askedTurnIds.has(turnId)) addTo(teamAttemptsByTurn, turnId, attempt);
    else unanchoredLaunches.push(attempt);
  }
  const offerByTurn = new Map(
    modelChoices
      .filter((offer) => offer.scope.kind === "chat")
      .map((offer) => [
        offer.scope.kind === "chat" ? offer.scope.turnId : "",
        offer,
      ]),
  );
  const activityGroups = groupResearchActivities(activities);
  const matchedGroups = new Set<string>();
  const outcomeByTurn = indexRenderableOutcomes(messages, outcomes);
  const messageItems: ConversationTimelineItem[] = messages.flatMap(
    (message, order) => {
      const group = findMessageActivityGroup(message, activityGroups);
      if (group) matchedGroups.add(group.key);
      const item = {
        kind: "message" as const,
        message,
        researchActivities: group?.activities ?? [],
        order,
      };
      const outcome =
        message.role === "user" && message.turnId !== undefined
          ? outcomeByTurn.get(message.turnId)
          : undefined;
      // Read from the question's own admitted record, not from any reply, so
      // the notice is on screen while the agent is still working and stays
      // there afterwards. Only default use is disclosed: an agent that chose
      // its own pair made a choice, even when that pair equals the default.
      // The turn's own default-mode speakers, and what named the session on
      // this turn. One notice: naming is part of what this turn did, and a
      // second surface would make a person look in two places for the same
      // kind of fact.
      // A chat title is owned by its turn where there is one, and by the
      // persisted user message where there is not: generic chat does not always
      // mint a turn id, and looking only at `turnId` would leave those sessions
      // with a record on disk and nothing on the page. One key, chosen the same
      // way the writer chooses the owner, so a turn that has an id is never
      // also looked up under its message id. Only chat operations are in this
      // map, so this cannot pull in a task or a fire.
      const titleAttemptsForMessage =
        message.role === "user"
          ? [
              ...(titleAttemptsByTurn.get(message.turnId ?? message.id) ?? []),
              // Only under this message's own turn identity. A Team launch
              // resolves to a turn, so a message that has none cannot be the
              // one it means.
              ...(message.turnId === undefined
                ? []
                : teamAttemptsByTurn.get(message.turnId) ?? []),
            ]
          : [];
      const defaultUses = [
        ...defaultUseSelections(message),
        ...titleAttemptsForMessage.map((attempt) => ({
          speaker: namedThingFor(attempt.operation),
          selection: attempt.selection,
          attemptId: attempt.attemptId,
        })),
      ];
      const offer =
        message.role === "user" && message.turnId !== undefined
          ? offerByTurn.get(message.turnId)
          : undefined;
      // Emitted as its own entry rather than hung off the message, because it
      // is not something the user said and a renderer walking messages must
      // not be able to mistake it for one.
      return [
        item,
        ...(defaultUses.length > 0
          ? [
              {
                kind: "model-selection" as const,
                userMessage: message,
                selections: defaultUses,
                order,
              },
            ]
          : []),
        ...(offer
          ? [
              {
                kind: "model-choice" as const,
                userMessage: message,
                offer,
                order,
              },
            ]
          : []),
        ...(outcome
          ? [
              {
                kind: "turn-outcome" as const,
                outcome,
                userMessage: message,
                order,
              },
            ]
          : []),
      ];
    },
  );
  const pendingGroupItems: ConversationTimelineItem[] = activityGroups
    .filter((group) => !matchedGroups.has(group.key))
    .map((group, order) => ({
      kind: "research-group" as const,
      runId: group.runId,
      agentPath: group.agentPath,
      researchActivities: group.activities,
      order: messages.length + order,
    }));
  // One notice per recorded attempt that has no brief to sit under, placed by
  // when it was recorded. Shown rather than dropped: it is an account of a model
  // that really was used, and the session it belongs to can be opened later.
  const sessionNoticeItems: ConversationTimelineItem[] = unanchoredLaunches.map(
    (attempt, order) => ({
      kind: "session-model-selection" as const,
      selections: [
        {
          speaker: namedThingFor(attempt.operation),
          selection: attempt.selection,
          attemptId: attempt.attemptId,
        },
      ],
      at: attempt.at,
      order: messages.length + activityGroups.length + order,
    }),
  );

  // One per key, in the order they were first reported. A delegation named its
  // job once and a run compressed a given round once; seeing either fact twice
  // does not make it two model uses.
  const seenHelpers = new Set<string>();
  const helperItems: ConversationTimelineItem[] = helperSelections
    .filter((helper) => {
      if (seenHelpers.has(helper.key)) return false;
      seenHelpers.add(helper.key);
      return true;
    })
    .map((helper, order) => ({
      kind: "session-model-selection" as const,
      selections: [
        {
          speaker: helper.speaker,
          selection: helper.selection,
          attemptId: helper.key,
        },
      ],
      at: helper.at,
      order: messages.length + activityGroups.length + unanchoredLaunches.length + order,
    }));

  return [
    ...messageItems,
    ...pendingGroupItems,
    ...sessionNoticeItems,
    ...helperItems,
  ].sort((left, right) => {
    const leftTime = timelineTime(left);
    const rightTime = timelineTime(right);
    return leftTime.localeCompare(rightTime) || left.order - right.order;
  });
}

interface ResearchActivityGroup {
  readonly key: string;
  readonly runId: string;
  readonly agentPath: string;
  readonly activities: ResearchActivity[];
}

/**
 * One group per turn per agent, whichever research tool recorded each step.
 *
 * Grouping on run and agent rather than on tool is what gives a turn a single
 * disclosure: a turn that searched and then drove the managed browser is still
 * one piece of work the user asked for.
 *
 * Steps keep the order the endpoint delivered. That order is not creation
 * order — `research_web` journals parallel calls in the provider's own call
 * order, because each crosses authorization, policy and budget gates
 * independently and can be recorded out of sequence — and it is not something
 * the renderer can reconstruct. Sorting again here is unsound as well as
 * redundant: an ordinal comparison between two research steps and a time
 * comparison involving a browser step, which carries no ordinal, need not
 * agree, so a browser step timed between two out-of-order provider calls makes
 * the three comparisons circular and lets the sort return any of them.
 */
function groupResearchActivities(
  activities: ResearchActivity[],
): ResearchActivityGroup[] {
  const groups = new Map<string, ResearchActivityGroup>();
  for (const activity of activities) {
    const key = `${activity.runId}\0${activity.agentPath}`;
    const existing = groups.get(key);
    if (existing) {
      existing.activities.push(activity);
    } else {
      groups.set(key, {
        key,
        runId: activity.runId,
        agentPath: activity.agentPath,
        activities: [activity],
      });
    }
  }
  return [...groups.values()];
}

function findMessageActivityGroup(
  message: ChatMessage,
  groups: readonly ResearchActivityGroup[],
): ResearchActivityGroup | undefined {
  if (
    message.role !== "assistant" ||
    message.speaker?.type !== "agent" ||
    !message.turnId
  ) return undefined;
  return groups.find((group) =>
    group.runId === message.turnId &&
    agentIdFromPath(group.agentPath) === message.speaker?.id);
}

/**
 * The outcomes worth putting on screen, by the turn they belong to.
 *
 * Three are dropped here rather than in the renderer. `pending` has nothing to
 * report yet; an outcome for a turn that did produce a reply would be a second
 * account of the same turn beside the first; and one whose question is not in
 * the loaded transcript would be an error message about a question nobody can
 * see.
 */
function indexRenderableOutcomes(
  messages: readonly ChatMessage[],
  outcomes: readonly ConversationTurnOutcome[],
): Map<string, ConversationTurnOutcome> {
  const answered = new Set(
    messages
      .filter((message) => message.role === "assistant" && message.turnId)
      .map((message) => message.turnId),
  );
  const asked = new Set(
    messages
      .filter((message) => message.role === "user" && message.turnId)
      .map((message) => message.turnId),
  );
  const renderable = new Map<string, ConversationTurnOutcome>();
  for (const outcome of outcomes) {
    if (outcome.state === "pending") continue;
    if (answered.has(outcome.turnId) || !asked.has(outcome.turnId)) continue;
    renderable.set(outcome.turnId, outcome);
  }
  return renderable;
}

function timelineTime(item: ConversationTimelineItem): string {
  if (item.kind === "message") return item.message.createdAt;
  if (item.kind === "turn-outcome") return item.userMessage.createdAt;
  if (item.kind === "model-selection") return item.userMessage.createdAt;
  if (item.kind === "session-model-selection") return item.at;
  if (item.kind === "model-choice") return item.userMessage.createdAt;
  return item.researchActivities[0]?.createdAt ?? "";
}

export function agentIdFromPath(agentPath: string): string {
  return agentPath.split("/").filter(Boolean).at(-1) ?? "Web Researcher";
}

/**
 * The speakers of one turn that ran on the application default.
 *
 * Sorted by speaker name so one turn's notice reads the same every render.
 */
function defaultUseSelections(
  message: ChatMessage,
): readonly { speaker: string; selection: ModelSelectionRecord }[] {
  const admitted = message.turnRequest?.admittedSelections;
  if (message.role !== "user" || !admitted) return [];
  return Object.entries(admitted)
    .filter(([, selection]) => selection.source === "app-default")
    .map(([speaker, selection]) => ({ speaker, selection }))
    .sort((left, right) => left.speaker.localeCompare(right.speaker));
}
