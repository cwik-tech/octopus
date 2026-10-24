/**
 * The Agent Skills specification rules, as one block both authors are given.
 *
 * Two places emit a `SKILL.md`: the Agent Architect, which writes a persona
 * and its skills together, and the skill author, which rewrites one skill on
 * an Agent that already exists. The repository's policy is that these rules
 * change everywhere or nowhere, so they are written once here and interpolated
 * rather than copied into each prompt. The text is byte-for-byte the section
 * the Agent Architect prompt carried before it was extracted.
 */
export const SKILL_AUTHORING_RULES = `## Skill authoring rules (Agent Skills specification)

Every SKILL.md you emit must conform to the Agent Skills specification
(https://agentskills.io/specification). These are hard constraints, not
preferences — a skill that breaks them is rejected by validation.

**Frontmatter.** A YAML block delimited by \`---\` lines. Only these keys are
defined by the spec; never invent others:

| Key | Required | Constraint |
| --- | --- | --- |
| \`name\` | yes | 1–64 chars, \`a-z\`, \`0-9\` and \`-\` only. No leading or trailing hyphen, no consecutive \`--\`. **Must equal the skill's folder name.** |
| \`description\` | yes | 1–1024 chars. Say what the skill does **and** when to use it, with the trigger keywords an agent would match on. |
| \`license\` | no | License name or bundled license file. |
| \`compatibility\` | no | ≤ 500 chars. Only when the skill needs specific tooling, packages, or network access. |
| \`metadata\` | no | Flat map of string keys to string values. |
| \`allowed-tools\` | no | Space-separated tool list. Experimental. |

Write \`name\` in kebab-case — never Title Case, never with spaces. If a
description contains a \`:\` followed by a space, or starts with a character
YAML treats specially, emit it as a folded block scalar (\`description: >\`
with the text indented two spaces on the following lines) so the frontmatter
still parses.

**Description quality.** One or two sentences: what the skill does, then a
"Use when …" clause naming the concrete situations that should trigger it.

- Good: \`Turn business claims into falsifiable hypotheses with evidence
  thresholds and decision rules. Use when validating a business idea, ranking
  risky assumptions, or deciding whether evidence justifies continuing.\`
- Bad: \`Method for business hypothesis validation.\` — says what, not when,
  and gives an agent nothing to match against.

**Body.** Keep SKILL.md under 500 lines and roughly under 5000 tokens; the
whole file loads into context the moment the skill activates. Move long
reference material into sibling files and link them with relative paths, one
level deep: \`references/\` for documentation, \`scripts/\` for executable
code, \`assets/\` for templates and data.

**Progressive disclosure.** \`name\` and \`description\` load at startup for
every installed skill, so the description carries the whole activation
decision. The body loads on activation. Everything else loads on demand.`
