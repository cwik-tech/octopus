/**
 * Rewrites that refuse to quietly do nothing.
 *
 * Several Electron specs reroute a bundled persona, team or workflow onto a
 * deterministic fixture by string-replacing one line of the shipped file:
 *
 *     persona.replace(/^provider:\s*.+$/m, 'provider: openai')
 *
 * The day the shipped file stops carrying that line — a provider sweep across
 * `agents/`, a renamed workflow step — the expression matches nothing and
 * `String.replace` hands back the input untouched. Nothing fails to compile and
 * no assertion fires. The spec simply runs against the real application default
 * while its name still claims it exercises the fixture, and it keeps passing
 * for whatever reason is left.
 *
 * Each helper below closes that gap in one of two ways, and choosing between
 * them is the whole point:
 *
 * - `replaceYamlField` edits a field that must already be there. Use it when
 *   absence is itself news worth failing over — a registry entry that lost its
 *   host routing, say.
 * - `setFrontMatterField` pins a persona field whether or not it exists, and
 *   throws only when there is no front matter to put it in. Use it where the
 *   field may legitimately disappear upstream but the test still has to pin the
 *   value, which is true of every `provider:`/`model:` line in `agents/`.
 * - `replaceRequiredText` is the literal/regex equivalent of the first, for
 *   fixture edits anchored on an exact string.
 *
 * Reaching for the permissive one where the strict one belongs re-creates the
 * silence. Reaching for the strict one where the value may legitimately be
 * absent turns an upstream change into a red spec with no defect behind it.
 */

const FRONT_MATTER_OPENING = '---\n'
const FRONT_MATTER_CLOSING = '\n---'

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function silentNoOp(details: {
  file: string
  looked: string
  pattern: string
  wanted: string
}): Error {
  return new Error(
    [
      `Rewrite matched nothing in ${details.file}`,
      `  looked for: ${details.looked}`,
      `  pattern:    ${details.pattern}`,
      `  wanted:     ${details.wanted}`,
      '',
      'The file no longer carries what this rewrite edits, so the rewrite would',
      'have returned the file untouched and the test would have run against the',
      'real application default instead of the fixture it names. Either the',
      'expectation is stale, or this call site should set the value rather than',
      'replace it.',
    ].join('\n'),
  )
}

/**
 * Replace every `field:` line in a YAML document, preserving its indentation.
 *
 * Throws when the field is absent, because a caller reaching for this helper is
 * asserting the field was there to begin with.
 */
export function replaceYamlField(options: {
  field: string
  /** Path or name of the file being rewritten, for the failure message. */
  file: string
  source: string
  value: string
}): string {
  const { field, file, source, value } = options
  const pattern = new RegExp(
    `^([ \\t]*)${escapeForRegExp(field)}:[^\\n]*$`,
    'gm',
  )
  let matches = 0
  const rewritten = source.replace(pattern, (_line, indent: string) => {
    matches += 1
    return `${indent}${field}: ${value}`
  })
  if (matches === 0) {
    throw silentNoOp({
      file,
      looked: `a top-level or indented \`${field}:\` line`,
      pattern: String(pattern),
      wanted: `${field}: ${value}`,
    })
  }
  return rewritten
}

/**
 * Replace several YAML fields at once — a registry's host routing pair, say.
 *
 * Fields are applied in key order and each carries the same guarantee as
 * `replaceYamlField`, so the call fails on the first field the document has
 * lost rather than half-pinning the routing.
 */
export function replaceYamlFields(options: {
  fields: Readonly<Record<string, string>>
  /** Path or name of the file being rewritten, for the failure message. */
  file: string
  source: string
}): string {
  const { fields, file, source } = options
  return Object.entries(fields).reduce(
    (carried, [field, value]) =>
      replaceYamlField({ field, file, source: carried, value }),
    source,
  )
}

/**
 * Pin a field in a Markdown file's YAML front matter, present or not.
 *
 * Replaces the field when the front matter declares it and appends it when it
 * does not, so a sweep that strips the field upstream cannot turn this into a
 * no-op. Throws when the file has no front matter at all — the one case where
 * the helper can neither find the field nor insert it.
 */
export function setFrontMatterField(options: {
  field: string
  /** Path or name of the file being rewritten, for the failure message. */
  file: string
  source: string
  value: string
}): string {
  const { field, file, source, value } = options
  const closingIndex = source.startsWith(FRONT_MATTER_OPENING)
    ? source.indexOf(FRONT_MATTER_CLOSING, FRONT_MATTER_OPENING.length)
    : -1
  if (closingIndex < 0) {
    throw new Error(
      [
        `No YAML front matter to set \`${field}\` in: ${file}`,
        `  wanted: ${field}: ${value}`,
        '',
        'A persona routed onto a fixture has to carry the fixture provider and',
        'model in its front matter. This file opens with no `---` block, so the',
        'value cannot be pinned and the test would have dispatched to whatever',
        'the application defaults to.',
      ].join('\n'),
    )
  }

  const frontMatter = source.slice(FRONT_MATTER_OPENING.length, closingIndex)
  const body = source.slice(closingIndex)
  const pattern = new RegExp(`^${escapeForRegExp(field)}:[^\\n]*$`, 'gm')
  let matches = 0
  const rewrittenFrontMatter = frontMatter.replace(pattern, () => {
    matches += 1
    return `${field}: ${value}`
  })
  const nextFrontMatter =
    matches > 0
      ? rewrittenFrontMatter
      : `${frontMatter}\n${field}: ${value}`
  return FRONT_MATTER_OPENING + nextFrontMatter + body
}

/**
 * Pin several front matter fields at once — the routing pair, usually.
 *
 * Fields are applied in key order and each one carries the same guarantee as
 * `setFrontMatterField`, so the call fails on the first field it can neither
 * find nor insert.
 */
export function setFrontMatterFields(options: {
  fields: Readonly<Record<string, string>>
  /** Path or name of the file being rewritten, for the failure message. */
  file: string
  source: string
}): string {
  const { fields, file, source } = options
  return Object.entries(fields).reduce(
    (carried, [field, value]) =>
      setFrontMatterField({ field, file, source: carried, value }),
    source,
  )
}

/**
 * Replace an exact string or regular expression that the caller requires.
 *
 * Throws when the pattern is absent, so a renamed fixture anchor fails here
 * rather than three assertions later against a document nobody edited.
 */
export function replaceRequiredText(options: {
  /** Path or name of the file being rewritten, for the failure message. */
  file: string
  pattern: RegExp | string
  replacement: string
  source: string
}): string {
  const { file, pattern, replacement, source } = options
  const present =
    typeof pattern === 'string'
      ? source.includes(pattern)
      : new RegExp(pattern.source, pattern.flags.replace('g', '')).test(source)
  if (!present) {
    throw silentNoOp({
      file,
      looked:
        typeof pattern === 'string'
          ? JSON.stringify(pattern)
          : 'a match for the expression below',
      pattern: String(pattern),
      wanted: JSON.stringify(replacement),
    })
  }
  return source.replace(pattern, replacement)
}
