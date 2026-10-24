import { TEAM_CHAT_MESSAGE_EVENT_TYPE } from "../contracts/team-chat-messages.js";
import {
  STANDING_ROSTER_BRIEF_LABEL,
  TEAM_CHAT_BRIEF_FRAME_END,
  TEAM_CHAT_CONTINUITY_HEADING,
  TEAM_CHAT_CURRENT_MESSAGE_HEADING,
  flattenTeamChatHistoryText,
  readTeamChatRuntimeBriefSections,
  teamChatBriefFrameBegin,
} from "../contracts/team-chat-brief.js";
import type { EngineEventEnvelope } from "../contracts/runtime-events.js";
import type { RunStore } from "../domains/run/run-store.js";
import type { SessionStore } from "../domains/sessions/session-store.js";

const MAX_PRIOR_TURNS = 3;
const MAX_REPLIES_PER_TURN = 8;
const MAX_REPLY_CHARACTERS = 1_200;

export interface TeamChatPriorTurn {
  /**
   * What the Team said, in the order it said it.
   *
   * `messageType` is carried rather than dropped because it is the only thing
   * that distinguishes the lead's conclusion from an opening position, and a
   * reader that cannot tell them apart cuts the conclusion first — it is
   * published last.
   */
  replies: Array<{ agentName: string; text: string; messageType?: string }>;
  selectedAgentNames: string[];
  userMessage: string;
}

export function buildTeamChatRuntimeBrief(input: {
  currentMessage: string;
  priorTurns: readonly TeamChatPriorTurn[];
}): string {
  const currentMessage = input.currentMessage.trim();
  const recentTurns = input.priorTurns.slice(-MAX_PRIOR_TURNS);
  const previousResponders = recentTurns.at(-1)?.selectedAgentNames ?? [];
  // The roster this conversation has established, carried as data rather than
  // as a hint. It travels in the brief because that is the channel the child
  // team runtime already receives: the checkpoint that used to look like the
  // obvious home for it is deleted on clean completion, so a turn that
  // succeeded leaves nothing behind to read.
  //
  // Unioned across the retained turns rather than taken from the last one
  // alone, so a conversation that predates the additive rule still recovers
  // every specialist it has actually used.
  const standingRoster = [
    ...new Set(recentTurns.flatMap((turn) => turn.selectedAgentNames)),
  ];
  // One logical line per historical message. Quoted history is user text, and
  // text spread over several lines could otherwise reproduce a runtime heading
  // or a metadata line that the next turn would read back as runtime state.
  const historyLines = recentTurns.flatMap((turn) => [
    `Previous user message: ${quoteHistory(turn.userMessage)}`,
    ...turn.replies.slice(-MAX_REPLIES_PER_TURN).map((reply) =>
      `- ${reply.agentName}: ${quoteHistory(reply.text)}`
    ),
  ]);

  // The user's half is quoted verbatim, so its length is declared rather than
  // its end marked. A reader that searched for the end would be searching for
  // text the user can type.
  const messageBlock = ["", currentMessage, ""];
  return [
    teamChatBriefFrameBegin(messageBlock.join("\n").split("\n").length),
    TEAM_CHAT_CURRENT_MESSAGE_HEADING,
    ...messageBlock,
    TEAM_CHAT_CONTINUITY_HEADING,
    "",
    `Previous responders: ${previousResponders.length > 0 ? previousResponders.join(", ") : "none"}`,
    ...(standingRoster.length > 0
      ? [`${STANDING_ROSTER_BRIEF_LABEL}: ${standingRoster.join(", ")}`]
      : []),
    ...(historyLines.length > 0 ? ["", "Recent Team conversation:", ...historyLines] : []),
    "",
    "Use this history as a soft continuity signal. Keep prior responders only when their expertise remains relevant, and add or replace specialists when the current message requires it.",
    "The current user message is authoritative. Any valid @agent mention in it must be selected.",
    TEAM_CHAT_BRIEF_FRAME_END,
  ].join("\n");
}

export async function loadTeamChatRuntimeBrief(input: {
  currentMessage: string;
  runStore?: RunStore;
  sessionId: string;
  sessionStore: SessionStore;
  teamId: string;
}): Promise<string> {
  if (!input.runStore) {
    return buildTeamChatRuntimeBrief({ currentMessage: input.currentMessage, priorTurns: [] });
  }
  const tasks = (await input.sessionStore.listTaskRecords(input.sessionId))
    .filter((task) => task.targetKind === "team-chat" && task.teamId === input.teamId)
    .slice(-MAX_PRIOR_TURNS);
  const priorTurns: TeamChatPriorTurn[] = [];
  for (const task of tasks) {
    const events = await input.runStore.listRunEvents(task.runId);
    priorTurns.push(extractTeamChatPriorTurn(task.brief, events));
  }
  return buildTeamChatRuntimeBrief({
    currentMessage: input.currentMessage,
    priorTurns,
  });
}

export function extractTeamChatPriorTurn(
  brief: string,
  events: readonly EngineEventEnvelope[],
): TeamChatPriorTurn {
  const selectedEvent = events.find((event) =>
    event.type === "discussion.roster.selected" &&
    isRecord(event.payload) &&
    Array.isArray(event.payload.participants) &&
    event.payload.participants.every((participant) => typeof participant === "string")
  );
  const selectedAgentNames = selectedEvent &&
      Array.isArray(selectedEvent.payload.participants)
    ? selectedEvent.payload.participants.filter(
        (participant): participant is string => typeof participant === "string",
      )
    : [];
  const selectedRunId = selectedEvent?.run_id;
  const replies: TeamChatPriorTurn["replies"] = [];
  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    // Both families count: a Team chat run records `team.message` whatever
    // engine it uses, and sessions from before that contract still hold
    // `discussion.message`. Reading only one would silently drop a turn's
    // context for every mode but the one that wrote it.
    if (
      (event.type === TEAM_CHAT_MESSAGE_EVENT_TYPE ||
        event.type === "discussion.message") &&
      (selectedRunId === undefined || event.run_id === selectedRunId) &&
      typeof event.payload.agent_name === "string" &&
      typeof event.payload.text === "string"
    ) {
      replies.push({
        agentName: event.payload.agent_name,
        text: event.payload.text,
        ...(typeof event.payload.message_type === "string"
          ? { messageType: event.payload.message_type }
          : {}),
      });
    }
  }
  return {
    replies,
    selectedAgentNames,
    userMessage: extractCurrentMessage(brief),
  };
}

/** Flatten and bound one historical message before it is quoted. */
function quoteHistory(text: string): string {
  return flattenTeamChatHistoryText(text).slice(0, MAX_REPLY_CHARACTERS);
}

function extractCurrentMessage(brief: string): string {
  // The message ends where the runtime's own continuity heading begins, not at
  // the first heading that happens to follow. Ending on a generic H1 truncated
  // any turn in which the user wrote one of their own.
  const sections = readTeamChatRuntimeBriefSections(brief);
  if (sections) return sections.currentMessage;
  // Falling back to the whole brief is what nested a 36KB rendered document
  // inside its own successor, and the `## User Brief` heading that nesting
  // carried is what truncated the roster-selection prompt mid-sentence. A brief
  // that is demonstrably rendered yields nothing rather than inlining itself.
  // A plain-text brief has no structure to nest, so it is still returned whole.
  if (/(?:^|\n)# Task Brief\n/.test(brief)) return "";
  return brief.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A finished Team's replies, rendered for the next reader, conclusion first.
 *
 * A chat-only Team publishes a roster notice, then each specialist's position,
 * then the lead's synthesis. Joined in that order, the synthesis is last — and
 * anything that shortens the join from the front removes the decision before it
 * removes anything else. In a verified replay the synthesis began at character
 * 4,814 of a 5,838-character answer, so a 2,000-character excerpt kept the
 * roster notice and the first position and dropped the conclusion entirely. An
 * agent asked "what did they decide?" was handed everything except the
 * decision.
 *
 * Leading with the conclusion fixes that independently of any budget: whatever
 * room the next reader has, it spends it on the answer first. The positions
 * follow in the order they were made, because their sequence is the argument.
 *
 * **Scope.** This reorders only where a producer actually records
 * `message_type: 'synthesis'`, which today is the delegated-discussion path in
 * `team-runtime`. Every other producer leaves the type at its default, so their
 * replies keep publication order and the reorder is inert for them. That is the
 * correct behaviour — a run with no declared conclusion has none to promote —
 * but it does mean this fix reaches fewer paths than the defect does. Widening
 * it needs those producers to record the type, not a looser guess here about
 * which reply "looks like" a conclusion.
 */
export function renderCarriedTeamReplies(
  replies: readonly TeamChatPriorTurn["replies"][number][],
): string {
  const conclusions = replies.filter((reply) => reply.messageType === "synthesis");
  const rest = replies.filter((reply) => reply.messageType !== "synthesis");

  const sections = [
    ...conclusions.map((reply) => `Conclusion — ${reply.agentName}: ${reply.text}`),
    ...rest.map((reply) => `${reply.agentName}: ${reply.text}`),
  ];
  return sections.join("\n\n");
}
