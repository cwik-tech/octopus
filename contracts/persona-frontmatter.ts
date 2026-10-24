/**
 * Pure persona frontmatter reads shared by the Agent package editor and the
 * Agent Architect, so the Tools tab and the Architect's view of a saved Agent
 * cannot disagree about what that Agent may use.
 */
import { readPersonaToolNames } from "./persona-tools.js";

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
  const match = new RegExp(`^${key}:[ \\t]*(.+?)\\s*$`, "m").exec(body);
  return match?.[1] ? stripQuotes(match[1]) : "";
}

export function parsePersonaToolList(markdown: string | null): string[] {
  return readPersonaToolNames(markdown);
}

export function parsePersonaBrowser(markdown: string | null): boolean {
  return parsePersonaToolList(markdown).includes("browser");
}

export function parsePersonaWebResearch(markdown: string | null): boolean {
  return parsePersonaToolList(markdown).includes("research_web");
}

export function parsePersonaGenerateWord(markdown: string | null): boolean {
  return parsePersonaToolList(markdown).includes("generate_word");
}

export function parsePersonaGenerateExcel(markdown: string | null): boolean {
  return parsePersonaToolList(markdown).includes("generate_excel");
}

export function parsePersonaBrowserDomains(markdown: string | null): string {
  const body = markdown ? frontmatterBody(markdown) : null;
  return body ? readField(body, "browser_domains") : "";
}

export function parsePersonaBrowserDomainsRestricted(
  markdown: string | null,
): boolean {
  const body = markdown ? frontmatterBody(markdown) : null;
  return body
    ? readField(body, "browser_restrict_domains").toLowerCase() === "true"
    : false;
}

/** The persona-declared tool state the Agent Tools tab shows. */
export interface PersonaToolState {
  readonly tools: readonly string[];
  readonly webResearch: boolean;
  readonly browserDomainsRestricted: boolean;
  readonly browserDomains: string;
  readonly generateWord: boolean;
  readonly generateExcel: boolean;
}

export function readPersonaToolState(markdown: string | null): PersonaToolState {
  return {
    tools: parsePersonaToolList(markdown),
    webResearch: parsePersonaWebResearch(markdown),
    browserDomainsRestricted: parsePersonaBrowserDomainsRestricted(markdown),
    browserDomains: parsePersonaBrowserDomains(markdown),
    generateWord: parsePersonaGenerateWord(markdown),
    generateExcel: parsePersonaGenerateExcel(markdown),
  };
}
