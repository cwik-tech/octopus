import type { AgentSummary } from "@/lib/models/agent-generator-model";
import { findHumanInputMentionTokens } from '@contracts/human-input'

export interface ActiveAgentMention {
  start: number;
  end: number;
  query: string;
}

export interface InsertedAgentMention {
  text: string;
  cursor: number;
}

export interface ResolvedAgentMentions {
  agentNames: string[];
  overflow: boolean;
}

export const MAX_AGENT_MENTIONS = 8;

const MENTION_START_CHARACTERS = "A-Za-z0-9";
const MENTION_TOKEN_CHARACTERS = `${MENTION_START_CHARACTERS}_-`;
const MENTION_PREFIX_CHARACTERS = `${MENTION_START_CHARACTERS}_.+%-`;
const MENTION_START_CHARACTER = new RegExp(
  `^[${MENTION_START_CHARACTERS}]$`,
);
const MENTION_TOKEN_CHARACTER = new RegExp(
  `^[${MENTION_TOKEN_CHARACTERS}]$`,
);
const MENTION_PREFIX_CHARACTER = new RegExp(
  `^[${MENTION_PREFIX_CHARACTERS}]$`,
);
export function findActiveAgentMention(
  text: string,
  cursor: number,
): ActiveAgentMention | null {
  const boundedCursor = Math.max(0, Math.min(cursor, text.length));
  if (boundedCursor === 0) return null;
  const start = text.lastIndexOf("@", boundedCursor - 1);
  if (start < 0) return null;

  const prefix = text[start - 1];
  if (prefix && MENTION_PREFIX_CHARACTER.test(prefix)) return null;

  const tokenStart = text[start + 1];
  if (tokenStart && !MENTION_START_CHARACTER.test(tokenStart)) return null;
  const query = text.slice(start + 1, boundedCursor);
  if (
    [...query.slice(1)].some(
      (character) => !MENTION_TOKEN_CHARACTER.test(character),
    )
  ) {
    return null;
  }

  let end = boundedCursor;
  while (end < text.length && MENTION_TOKEN_CHARACTER.test(text[end] ?? "")) {
    end += 1;
  }

  return { start, end, query };
}

export function insertAgentMention(
  text: string,
  mention: ActiveAgentMention,
  agentName: string,
): InsertedAgentMention {
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  const token = `@${agentName}`;
  const spacer = after.length === 0 ? " " : "";
  return {
    text: `${before}${token}${spacer}${after}`,
    cursor: before.length + token.length + spacer.length,
  };
}

export function hasAgentMentionSyntax(text: string): boolean {
  return findHumanInputMentionTokens(text).length > 0
}

export function resolveAgentMentions(
  text: string,
  agents: readonly Pick<AgentSummary, 'name'>[],
): ResolvedAgentMentions {
  const canonicalNameByLowercase = new Map(
    agents.map((agent) => [agent.name.toLowerCase(), agent.name]),
  );
  const agentNames: string[] = [];
  const seen = new Set<string>();

  for (const candidate of findHumanInputMentionTokens(text)) {
    const agentName = canonicalNameByLowercase.get(candidate);
    if (!agentName || seen.has(agentName)) continue;
    seen.add(agentName);
    agentNames.push(agentName);
  }

  return {
    agentNames,
    overflow: agentNames.length > MAX_AGENT_MENTIONS,
  };
}
