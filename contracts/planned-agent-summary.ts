/**
 * The proposal-card copy for a planned Agent, and the one limit it obeys.
 *
 * A planned Agent carries two pieces of prose. `summary` is one plain sentence
 * written for the proposal card. `description` is the detailed brief the Agent
 * generator builds the package from, and it has no display limit.
 *
 * The limit lives in the contracts layer because both sides need it: the
 * provider schema, the proposal parser and the response contract enforce or
 * state it (through `domains/agent-generator/planned-agent-rules.ts`), and the
 * renderer, which may import only contracts, derives card copy under it.
 */

import type { PlannedAgentSpec } from "./agent-generator.js";

/**
 * The most characters a card summary may have, counted as code points, which
 * is how the provider schema's `maxLength` counts them.
 *
 * A validation bound for newly authored proposals, not a model context budget,
 * so it does not belong in `core/context-limits.ts`.
 */
export const MAX_PLANNED_AGENT_SUMMARY_LENGTH = 240;

const ELLIPSIS = "…";

/**
 * What the proposal card shows for a planned Agent.
 *
 * The summary its author wrote, when it has one. A plan saved before summaries
 * existed has none, so the card derives copy from its build brief instead. The
 * derived copy is for display only: nothing writes it back, because the plan's
 * revision and an update operation's identity are digests over the stored
 * record.
 */
export function plannedAgentCardSummary(
  agent: Pick<PlannedAgentSpec, "summary" | "description" | "role">,
): string {
  if (typeof agent.summary === "string" && agent.summary.trim().length > 0) {
    return agent.summary;
  }
  const brief = withoutMarkdownSyntax(agent.description.replace(/\r\n?/gu, "\n")).trim();
  return boundToCard(brief.length > 0 ? brief : agent.role.trim());
}

/** The start of a Markdown heading line, such as `## Purpose`. */
const MARKDOWN_HEADING = /^[ \t]*#{1,6}(?:\s|$)/u;

/**
 * The brief without the Markdown the card would show as literal characters:
 * the heading lines before its first line of prose, and `**` bold markers. A
 * heading labels a section, so the card shows the prose under it.
 */
function withoutMarkdownSyntax(text: string): string {
  const lines = text.split("\n");
  const firstProse = lines.findIndex((line) => line.trim() !== "" && !MARKDOWN_HEADING.test(line));
  return firstProse === -1 ? "" : lines.slice(firstProse).join("\n").replaceAll("**", "");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * The first complete sentence, with its whitespace collapsed, when it fits the
 * card. Otherwise the words that fit in one character less than the limit, and
 * one ellipsis.
 */
function boundToCard(text: string): string {
  const sentence = collapseWhitespace(firstSentence(text));
  if (Array.from(sentence).length <= MAX_PLANNED_AGENT_SUMMARY_LENGTH) return sentence;
  return `${clipAtWordBoundary(sentence, MAX_PLANNED_AGENT_SUMMARY_LENGTH - 1)}${ELLIPSIS}`;
}

/** Closing quotes and brackets that belong to the sentence they close. */
const CLOSERS = "\"'”’)\\]」』）";

/**
 * Every place a sentence may end, in text order: a `.`, `!` or `?` followed by
 * whitespace or the end; a `。`, `！` or `？`, which needs no space after it; a
 * blank line; a line break before a list item; and a line break before a
 * Markdown heading.
 */
const SENTENCE_BOUNDARY = new RegExp(
  [
    `[.!?]+[${CLOSERS}]*(?=\\s|$)`,
    `[。！？][${CLOSERS}]*`,
    `\\n[ \\t]*\\n`,
    `\\n(?=[ \\t]*(?:[-*•+]|\\d+[.)]|\\p{L}[.)])[ \\t])`,
    `\\n(?=[ \\t]*#{1,6}(?:\\s|$))`,
  ].join("|"),
  "gu",
);

/** Titles and short forms whose full stop does not end a sentence. */
const ABBREVIATION = /^(?:mr|mrs|ms|dr|prof|st|vs|cf|approx|incl)$/iu;

/**
 * The brief up to the end of its first sentence. The brief keeps its line
 * breaks here, because a blank line or a list tells where an untitled heading
 * ends. Text with no boundary is one sentence.
 */
function firstSentence(text: string): string {
  for (const match of text.matchAll(SENTENCE_BOUNDARY)) {
    const boundary = match[0];
    const start = match.index;
    const end = start + boundary.length;
    if (boundary.startsWith("\n")) {
      // A line ending in a colon leads into the paragraph or list after it.
      if (!text.slice(0, start).trimEnd().endsWith(":")) return text.slice(0, start);
    } else if (/^[。！？]/u.test(boundary) || endsSentence(text, start, end, boundary)) {
      return text.slice(0, end);
    }
  }
  return text;
}

/**
 * Whether a `.`, `!` or `?` really ends a sentence.
 *
 * Not when a lower-case word follows, as after "etc." in mid-sentence. And a
 * single full stop does not end one after an abbreviation such as "e.g.",
 * "U.S." or "Dr.", or after the number or letter of a list item at the start
 * of a line or after a colon, as in "1. Find each clause".
 */
function endsSentence(text: string, start: number, end: number, boundary: string): boolean {
  const next = /\S/u.exec(text.slice(end))?.[0];
  if (next !== undefined && /\p{Ll}/u.test(next)) return false;
  if (!/^\.(?![.!?])/u.test(boundary)) return true;
  const token = /\S*$/u.exec(text.slice(0, start))?.[0] ?? "";
  const word = token.replace(/^[("'“‘[]+/u, "");
  if (/^(?:\p{L}\.)+\p{L}$/u.test(word) || ABBREVIATION.test(word)) return false;
  if (/^(?:\d+|\p{L})$/u.test(word)) {
    const before = text.slice(0, start - token.length);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    if (/^\s*$/u.test(line) || /:\s+$/u.test(line)) return false;
  }
  return true;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The longest run of whole words within `limit` code points. A single word
 * longer than that, such as an unbroken URL, is cut at the limit instead, but
 * only between visible characters, so a letter never loses its accent.
 * Whitespace is already collapsed to single spaces here.
 */
function clipAtWordBoundary(text: string, limit: number): string {
  let head = "";
  let length = 0;
  let next = "";
  for (const { segment } of GRAPHEMES.segment(text)) {
    const size = Array.from(segment).length;
    if (length + size > limit) {
      next = segment;
      break;
    }
    head += segment;
    length += size;
  }
  if (next === "" || next === " ") return head.trimEnd();
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd();
}
