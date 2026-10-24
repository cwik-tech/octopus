/**
 * Splits a Markdown source into its YAML frontmatter block and its body.
 *
 * `SKILL.md` frontmatter is YAML, so a description may legitimately be a
 * folded block scalar (`description: >`) — the form the Agent Skills
 * specification requires whenever the text contains a `: `. Reading it line by
 * line yields the `>` marker instead of the text, so every reader of skill
 * metadata goes through the real YAML parser here.
 *
 * Agent persona files are read by `parseAgentFrontmatter` in
 * `parsers/load-agent.ts` instead, which keeps a flat
 * `Record<string, string>` contract its callers depend on.
 */

import { parseYaml } from './yaml-parser.js'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export interface MarkdownFrontmatter {
  /**
   * The parsed frontmatter mapping. Empty when the source carries no
   * frontmatter block or when the block cannot be parsed.
   */
  metadata: Record<string, unknown>
  /** Everything after the closing `---`, or the whole source when absent. */
  body: string
}

export function parseMarkdownFrontmatter(source: string): MarkdownFrontmatter {
  const match = source.match(FRONTMATTER_PATTERN)
  const frontmatterSource = match?.[1]
  if (!match || frontmatterSource === undefined) return { metadata: {}, body: source }

  const body = source.slice(match[0].length)
  try {
    return { metadata: parseYaml(frontmatterSource), body }
  } catch {
    return { metadata: {}, body }
  }
}

/**
 * Narrows a frontmatter value to a non-empty trimmed string. Anything else —
 * a missing key, an empty folded scalar (which parses to `null`), a nested
 * mapping, a list — yields `undefined` so the caller can fall back.
 */
export function frontmatterString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}
