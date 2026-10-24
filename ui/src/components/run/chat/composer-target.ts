import type { SessionMessageTarget } from "@contracts/schemas/session-requests";
import type { AgentSummary } from "@/lib/models/agent-generator-model";
import {
  hasAgentMentionSyntax,
  resolveAgentMentions,
} from "@/lib/utils/agent-mentions";

/**
 * Where the composer's next turn would actually go.
 *
 * One derivation, read twice: the submit path routes by it, and the line under
 * the composer describes it. They were two derivations, and the caption
 * described the standing target while a mention in the draft overrode it, so
 * "@analyst summarize this" was labelled as a General Agent answer and then
 * sent to Analyst.
 *
 * Pure, and it raises nothing. The submit path owns the error copy and the
 * draft restore; this only says what it found.
 */
export interface ComposerTarget {
  /** The effective target, or `undefined` for an untargeted turn. */
  readonly target?: SessionMessageTarget;
  /**
   * The draft mentions agents but the catalog has not loaded.
   *
   * Submit refuses such a turn. The caption cannot name the addressee either,
   * and saying the standing target would name the wrong one.
   */
  readonly mentionsPending: boolean;
  /** More mentions than one turn may carry. Submit refuses; the caption says so. */
  readonly overflow: boolean;
}

export function resolveComposerTarget(input: {
  /** The draft as typed. Trimming is the caller's business at submit. */
  text: string;
  /** The standing selection from the sidebar. */
  target?: SessionMessageTarget;
  /** The Team this conversation is fixed to, when it is fixed to one. */
  targetTeamId: string | null;
  /** A retry naming its own addressee, which consults nothing else. */
  routedTo?: SessionMessageTarget;
  mentionAgents: readonly Pick<AgentSummary, "name">[];
  mentionAgentsReady: boolean;
}): ComposerTarget {
  if (input.routedTo !== undefined) {
    return { target: input.routedTo, mentionsPending: false, overflow: false };
  }
  // A Team carries its own roster, so a mention inside a Team turn would be
  // addressing someone the Team has not convened.
  const usesAgentMentions = input.targetTeamId === null;
  if (!usesAgentMentions) {
    return {
      ...(input.target ? { target: input.target } : {}),
      mentionsPending: false,
      overflow: false,
    };
  }

  const text = input.text;
  if (hasAgentMentionSyntax(text) && !input.mentionAgentsReady) {
    return {
      ...(input.target ? { target: input.target } : {}),
      mentionsPending: true,
      overflow: false,
    };
  }

  const resolved = resolveAgentMentions(text, input.mentionAgents);
  if (resolved.overflow) {
    return {
      ...(input.target ? { target: input.target } : {}),
      mentionsPending: false,
      overflow: true,
    };
  }
  if (resolved.agentNames.length > 0) {
    return {
      target: { kind: "agents", agentNames: resolved.agentNames },
      mentionsPending: false,
      overflow: false,
    };
  }
  return {
    ...(input.target ? { target: input.target } : {}),
    mentionsPending: false,
    overflow: false,
  };
}
