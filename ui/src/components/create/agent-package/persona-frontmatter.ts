import { readAgentModelChoice } from "@contracts/agent-model-selection";
import {
  parsePersonaBrowser,
  parsePersonaBrowserDomains,
  parsePersonaBrowserDomainsRestricted,
  parsePersonaGenerateExcel,
  parsePersonaGenerateWord,
  parsePersonaToolList,
  parsePersonaWebResearch,
} from "@contracts/persona-frontmatter";
import { writePersonaToolNames } from "@contracts/persona-tools";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function frontmatterBody(markdown: string): string | null {
  if (!markdown.startsWith("---")) return null;
  return FRONTMATTER_RE.exec(markdown)?.[1] ?? null;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readField(body: string, key: string): string {
  const value = new RegExp(`^${key}:[ \\t]*(.+?)\\s*$`, "m").exec(body)?.[1];
  return value === undefined ? "" : stripQuotes(value);
}

function setField(body: string, key: string, value: string): string {
  const fieldPattern = new RegExp(`^${key}:[ \\t]*.*$`, "m");
  if (fieldPattern.test(body)) {
    return body.replace(fieldPattern, `${key}: ${value}`);
  }
  return body.length > 0 ? `${body}\n${key}: ${value}` : `${key}: ${value}`;
}

function applyField(markdown: string, key: string, value: string): string {
  const match = markdown.startsWith("---") ? FRONTMATTER_RE.exec(markdown) : null;
  if (!match) return `---\n${key}: ${value}\n---\n\n${markdown}`;
  const body = setField(match[1] ?? "", key, value);
  return `---\n${body}\n---${markdown.slice(match[0].length)}`;
}

/**
 * Removes a field from the frontmatter entirely.
 *
 * App-default mode is the *absence* of a provider and model, not a copy of
 * today's default written into the file. Removing the fields is what keeps the
 * agent inheriting after the application default changes.
 */
function removeField(markdown: string, key: string): string {
  const match = markdown.startsWith("---") ? FRONTMATTER_RE.exec(markdown) : null;
  if (!match) return markdown;
  const body = (match[1] ?? "")
    .split("\n")
    .filter((line) => !new RegExp(`^${key}:[ \\t]*`).test(line))
    .join("\n");
  return `---\n${body}\n---${markdown.slice(match[0].length)}`;
}

/**
 * How an agent declares its runtime model.
 *
 * The three states are the shared contract's, read by the shared contract's
 * own function. Keeping the editor's own rules here let it disagree with the
 * runtime in both directions: a half-configured pair showed as inheritance,
 * and the legacy `codex/default` placeholder showed as an explicit choice. An
 * editor that disagrees with the runtime lets a user save something other than
 * what will run.
 */
export type PersonaModelMode =
  | { mode: "explicit"; provider: string; model: string }
  | { mode: "app-default" }
  | { mode: "invalid"; message: string; provider?: string; model?: string };

export function parsePersonaModelMode(
  markdown: string | null,
): PersonaModelMode {
  const { provider, model } = parsePersonaModel(markdown);
  const reading = readAgentModelChoice({ provider, model });
  if (reading.choice?.mode === "explicit") {
    return {
      mode: "explicit",
      provider: reading.choice.provider,
      model: reading.choice.model,
    };
  }
  if (reading.choice) return { mode: "app-default" };
  return {
    mode: "invalid",
    message: reading.error?.message ?? "This agent's model cannot be read.",
    ...(reading.error?.provider ? { provider: reading.error.provider } : {}),
    ...(reading.error?.model ? { model: reading.error.model } : {}),
  };
}

/** Switches an agent to inheriting the one application default. */
export function applyPersonaAppDefault(markdown: string): string {
  return removeField(removeField(markdown, "provider"), "model");
}

export function parsePersonaModel(markdown: string | null): {
  provider: string;
  model: string;
} {
  const body = markdown ? frontmatterBody(markdown) : null;
  if (!body) return { provider: "", model: "" };
  return {
    provider: readField(body, "provider"),
    model: readField(body, "model"),
  };
}

export function applyPersonaModel(
  markdown: string,
  provider: string,
  model: string,
): string {
  const match = markdown.startsWith("---") ? FRONTMATTER_RE.exec(markdown) : null;
  if (!match) {
    return `---\nprovider: ${provider}\nmodel: ${model}\n---\n\n${markdown}`;
  }
  let body = setField(match[1] ?? "", "provider", provider);
  body = setField(body, "model", model);
  return `---\n${body}\n---${markdown.slice(match[0].length)}`;
}

// The tool reads live in the shared contract, so the Agent Architect reads a
// saved persona exactly as this editor's Tools tab does.
export {
  parsePersonaBrowser,
  parsePersonaBrowserDomains,
  parsePersonaBrowserDomainsRestricted,
  parsePersonaGenerateExcel,
  parsePersonaGenerateWord,
  parsePersonaToolList,
  parsePersonaWebResearch,
};

export function applyPersonaBrowserDomainsRestricted(
  markdown: string,
  restricted: boolean,
): string {
  return applyField(
    markdown,
    "browser_restrict_domains",
    restricted ? "true" : "false",
  );
}

export function applyPersonaBrowserDomains(
  markdown: string,
  domains: string,
): string {
  const value = domains
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
    .join(", ");
  return applyField(markdown, "browser_domains", value);
}

export function applyPersonaTool(
  markdown: string,
  toolName: string,
  enabled: boolean,
): string {
  const current = parsePersonaToolList(markdown);
  const hasTool = current.includes(toolName);
  let next = current;
  if (enabled && !hasTool) next = [...current, toolName];
  else if (!enabled && hasTool) {
    next = current.filter((tool) => tool !== toolName);
  }
  return writePersonaToolNames(markdown, next);
}

export function applyPersonaBrowser(markdown: string, enabled: boolean): string {
  return applyPersonaTool(markdown, "browser", enabled);
}

export function applyPersonaWebResearch(
  markdown: string,
  enabled: boolean,
): string {
  return applyPersonaTool(markdown, "research_web", enabled);
}

export function applyPersonaGenerateWord(
  markdown: string,
  enabled: boolean,
): string {
  return applyPersonaTool(markdown, "generate_word", enabled);
}

export function applyPersonaGenerateExcel(
  markdown: string,
  enabled: boolean,
): string {
  return applyPersonaTool(markdown, "generate_excel", enabled);
}

/**
 * The effort level this persona names, or `null` when it names none.
 *
 * Absence is reported rather than resolved. An agent that never named a level
 * runs at the application default, and an agent that asked for `medium` runs at
 * medium no matter what that default becomes — the two are different states and
 * the editor has to be able to show which one it is looking at.
 */
export function parsePersonaEffort(markdown: string | null): string | null {
  const body = markdown ? frontmatterBody(markdown) : null;
  if (!body) return null;
  const value = readField(body, "thinking");
  return value ? value : null;
}

/**
 * Writes the chosen level, or removes the field to follow the default again.
 *
 * `null` removes rather than writing the default's current value, for the same
 * reason the model control stores app-default mode as an absence: a copy taken
 * today stops following the setting tomorrow, and nothing on screen would say
 * that had happened.
 */
export function applyPersonaEffort(
  markdown: string,
  level: string | null,
): string {
  return level === null
    ? removeField(markdown, "thinking")
    : applyField(markdown, "thinking", level);
}
