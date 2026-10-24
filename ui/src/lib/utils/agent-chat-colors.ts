import type { ChatMessage } from "@/lib/models/session-model";
import { GENERAL_AGENT_NAME } from "@contracts/front-door";

/**
 * The General Agent's heading/icon color: the theme accent. It is fixed rather
 * than assigned by order of appearance, so the General Agent looks the same in
 * every message, and the palette below leaves it out so no other agent is
 * given it.
 */
const GENERAL_AGENT_COLOR_THEME = {
  avatar: "border-primary/35 bg-accent text-primary-text",
  text: "text-primary-text",
} as const;

export const GENERAL_AGENT_COLOR_CLASS = GENERAL_AGENT_COLOR_THEME.text;

/**
 * Distinct heading/icon colors for the other agents in the Run chat.
 *
 * Colors are assigned by order of first appearance among agent speakers so
 * every agent visible in a conversation gets a different color (until the
 * palette is exhausted, after which colors repeat). Each entry pairs a
 * light-mode and dark-mode tone so labels stay legible in both themes.
 *
 * Full class strings are listed as literals so Tailwind detects them.
 */
export const AGENT_CHAT_COLOR_THEMES = [
  {
    avatar: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  {
    avatar: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    text: "text-violet-600 dark:text-violet-400",
  },
  {
    avatar: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    text: "text-amber-600 dark:text-amber-400",
  },
  {
    avatar: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
    text: "text-rose-600 dark:text-rose-400",
  },
  {
    avatar: "border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    text: "text-cyan-600 dark:text-cyan-400",
  },
  {
    avatar: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
    text: "text-fuchsia-600 dark:text-fuchsia-400",
  },
  {
    avatar: "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-400",
    text: "text-teal-600 dark:text-teal-400",
  },
  {
    avatar: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400",
    text: "text-orange-600 dark:text-orange-400",
  },
  {
    avatar: "border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    text: "text-indigo-600 dark:text-indigo-400",
  },
  {
    avatar: "border-lime-500/40 bg-lime-500/10 text-lime-600 dark:text-lime-400",
    text: "text-lime-600 dark:text-lime-400",
  },
  {
    avatar: "border-pink-500/40 bg-pink-500/10 text-pink-600 dark:text-pink-400",
    text: "text-pink-600 dark:text-pink-400",
  },
] as const;

const [FIRST_AGENT_CHAT_COLOR_THEME, ...OTHER_AGENT_CHAT_COLOR_THEMES] =
  AGENT_CHAT_COLOR_THEMES;

export const AGENT_CHAT_COLOR_CLASSES: readonly [string, ...string[]] = [
  FIRST_AGENT_CHAT_COLOR_THEME.text,
  ...OTHER_AGENT_CHAT_COLOR_THEMES.map((theme) => theme.text),
];

/** Stable identity for an agent speaker; prefers the id, falls back to the name. */
export function agentColorKey(speaker: { id?: string; name?: string }): string {
  return (speaker.id || speaker.name || "")
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");
}

const GENERAL_AGENT_COLOR_KEY = agentColorKey({ id: GENERAL_AGENT_NAME });

/**
 * Map each distinct agent speaker in a message list to a color class, assigned
 * in order of first appearance. Non-agent speakers (the generic assistant)
 * are omitted — they keep the default muted heading.
 */
export function buildAgentColorMap(
  messages: ChatMessage[],
): Map<string, string> {
  return buildAgentColorMapFromSpeakers(
    messages.flatMap((message) =>
      message.role === "assistant" && message.speaker?.type === "agent"
        ? [message.speaker]
        : []
    ),
  );
}

export function buildAgentColorMapFromSpeakers(
  speakers: readonly { id?: string; name?: string }[],
): Map<string, string> {
  const map = new Map<string, string>();
  let next = 0;
  for (const speaker of speakers) {
    const key = agentColorKey(speaker);
    if (!key || map.has(key)) continue;
    if (key === GENERAL_AGENT_COLOR_KEY) {
      map.set(key, GENERAL_AGENT_COLOR_CLASS);
      continue;
    }
    map.set(
      key,
      AGENT_CHAT_COLOR_CLASSES[next % AGENT_CHAT_COLOR_CLASSES.length] ??
        AGENT_CHAT_COLOR_CLASSES[0],
    );
    next += 1;
  }
  return map;
}

export function agentAvatarColorClass(colorClass?: string | null): string {
  return [GENERAL_AGENT_COLOR_THEME, ...AGENT_CHAT_COLOR_THEMES]
    .find((theme) => theme.text === colorClass)
    ?.avatar ??
    "border-border bg-muted text-muted-foreground";
}
