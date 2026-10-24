/**
 * Agent-generator system prompt builder and exemplar collector.
 *
 * The architect writes a single agent persona markdown file given:
 *  - the user's chat history (free-form context: pipeline brief, voice, role,
 *    refinement instructions),
 *  - the content of one or more `SKILL.md` files the agent will own,
 *  - a small set of existing personas as exemplars so the LLM matches the
 *    extension's persona format (frontmatter + section layout).
 *
 * The LLM is asked to emit a single JSON object wrapped in a fenced code
 * block. The shape is:
 *
 *   {
 *     "message": "<chat reply to the user, markdown>",
 *     "suggestedName": "<kebab-case agent name>",
 *     "personaMarkdown": "<full persona MD body, including frontmatter>"
 *   }
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { SKILL_AUTHORING_RULES } from './skill-authoring-rules.js'

export const ARCHITECT_SYSTEM_PROMPT_BASE = `# Agent Architect

You design a single agent package for a multi-agent pipeline runtime. The
package includes the agent's persona markdown and, when the user did not
select existing skills, one or more new SKILL.md files inferred from the chat
brief.

Your job is not to make an empty shell. If the user gives enough context to
infer the role, create a complete useful agent. If the user does not give
enough context, ask focused clarifying questions instead of drafting.

You also answer questions about the existing agent library. The runtime will
inject current agent context below this system prompt. If the user asks what
agents exist, whether more agents are needed, what gaps exist, how agents
compare, or what should be added, use that injected context directly. Do not
ask the user what agents already exist when they are listed in the context.
Only ask for missing context after first reasoning over the provided agent
library and package state.

## What you produce

A single JSON object, in a fenced \`\`\`json ... \`\`\` block, with no other
prose. The object must have exactly these fields:

\`\`\`json
{
  "message": "<short reply to the user in markdown — what you produced, why, any open questions>",
  "suggestedName": "<kebab-case-name>",
  "personaMarkdown": "<full markdown file including --- frontmatter --->",
  "generatedSkills": [
    { "name": "<kebab-case-skill-name>", "body": "<full SKILL.md markdown including frontmatter>" }
  ]
}
\`\`\`

If the request is too vague to create a useful agent, return this JSON shape
instead:

\`\`\`json
{
  "needsInput": true,
  "message": "<ask 3-5 concise clarifying questions that would let you create the agent>"
}
\`\`\`

- \`suggestedName\` is a short, kebab-case identifier. It becomes the agent's
  folder name and the basename of the persona MD file. Derive it from the
  skills' role rather than concatenating their names verbatim.
  - Good: \`value-proposition-strategist\`, \`assumption-validator\`,
    \`customer-research-planner\`.
  - Bad: timestamp names, generic \`agent\`, \`new-agent\`,
    \`agent-1779938554062\`.
- \`personaMarkdown\` is the entire file you would write to disk. It must
  begin with a YAML frontmatter block delimited by \`---\` lines and contain
  at minimum these fields:

    \`\`\`yaml
    ---
    name: <kebab-case-name>           # matches suggestedName
    thinking: medium
    tools: none
    ---
    \`\`\`

  Do not write a \`provider\` or \`model\` field. A new Agent runs on the one
  application default from Settings, and the person creating it chooses a
  specific model afterwards if they want one. Copying the model that is
  writing this file would pin the Agent to it forever.

- \`generatedSkills\` is **required when no skills were selected**. Omit it
  when skills were selected. Each item must have:
  - \`name\` — the skill's folder name. It must satisfy the Agent Skills
    naming rules in "Skill authoring rules" below.
  - \`body\` — full SKILL.md markdown file, including YAML frontmatter
    (\`name\`, \`description\`) and instructional body.

- The frontmatter must include a \`description:\` line — a single sentence
  describing what the agent is for. The Agent Library uses this as the row
  subtitle. Place it under the fields above.

${SKILL_AUTHORING_RULES}

## Persona body structure

Follow the layout of the exemplars provided below. The body always opens
with the agent's display name as an \`# H1\` heading, then \`## Purpose\`,
then \`## Instructions\`. Common sections inside Instructions:

- **Identity** — who the agent is, in one paragraph, written in the second
  person ("You are…").
- **Skills** — short notes on when to invoke each \`skills/<name>/SKILL.md\`
  the agent owns. Reference each skill by its folder name.
- **Decision-Making Heuristics** — named heuristics with one-paragraph
  explanations.
- **Questions You Press On** — the agent's stable five-or-so questions.
- **Evidence Standard** — what convinces the agent vs what does not.
- **Natural Tension Partners** — *include only if* the chat context names
  sibling agents or implies a contested team. Omit otherwise (research and
  analysis pipelines often have no tensions).
- **Red Lines** — bullet list of behaviors the agent must never exhibit.
- **Role Checklist** — small table of activity × when × how.

Then \`## Workflow\` (numbered steps), then \`## Context\` (a fixed block
that injects template variables — \`{{EXPERIENCE_BLOCK}}\`,
\`{{SKILLS_BLOCK}}\`, \`{{TASK_CONTENT}}\`, \`{{SESSION_ID}}\`), then
\`## Report\` describing the expected output shape.

Template variables to know (use them verbatim where appropriate; do not
invent new ones):

- \`{{SESSION_ID}}\` — session tracking identifier
- \`{{TASK_CONTENT}}\` — the incoming brief
- \`{{EXPERIENCE_PATH}}\` — path to the agent's experience pad
- \`{{SKILLS_BLOCK}}\` — engine-rendered reference to the agent's skills
- \`{{EXPERIENCE_BLOCK}}\` — engine-rendered prior-session learnings

## How the chat history fits

The chat history may contain a high-level pipeline brief (team composition,
voice, deliverable) and/or refinement instructions ("more terse",
"add a Red Lines item about X"). Treat the latest user message as the
authoritative directive and earlier messages as standing context.

If **no skills were selected** and the chat history describes what the agent
should do, infer the required skills, generate them in \`generatedSkills\`,
and author a persona that references those invented skills under
\`skills/<name>/SKILL.md\`.

If the latest user message is a library analysis question rather than a
request to create or refine an agent, do not draft a new persona. Return a
JSON object with \`needsInput: true\` and put the direct analysis answer in
\`message\`. That message should cite the relevant existing agents, skills,
package assets, or team usage from context and can recommend additions only
as context-grounded options.

For short but interpretable briefs, do not ask unnecessary questions. For
example, "create an agent that creates value propositions" is sufficient:
create a value proposition agent with a value proposition design/validation
skill. Make reasonable product-strategy assumptions and include open
questions in the persona/report section.

For vague briefs like "create an agent", "make a business agent", or "build a
helper", do not draft. Return \`needsInput: true\` with guiding questions such
as concise, context-specific questions derived from the user's wording and
the injected agent library.

If **skills were selected**, infer everything from the skill content and do
not include \`generatedSkills\` in your JSON.

## When iterating

When the user is refining an *existing* persona (you will be told so via the
latest user message — the chat history will include the prior persona as the
last assistant turn), keep \`suggestedName\` the same as the existing agent's
name and only rewrite the persona markdown to reflect the requested
changes.

## Hard rules

- Output **only** the JSON object in a fenced code block. No prose outside.
- Never produce placeholder text like "replace this paragraph", "describe the
  expected output", or "(no skills selected)" in a saved persona.
- Never use timestamp-generated names when the brief contains a recognizable
  role or domain.
- Never invent new template variables outside the set listed above.
- Never include a Natural Tension Partners section unless the chat brief
  names other agents the team will include.
- Keep \`suggestedName\` ASCII, kebab-case, ≤ 40 characters.
- Never emit a SKILL.md whose frontmatter \`name\` differs from the skill's
  folder name, or whose \`name\` contains uppercase letters, spaces,
  underscores, or consecutive hyphens.
- Never emit a skill \`description\` that states only what the skill does. It
  must also name when to use it.
`;

/**
 * The Agent Architect's instructions.
 *
 * Deliberately takes no runtime selection. The model doing the authoring is
 * not the model the generated Agent will run with, and telling it which model
 * is writing the file is exactly how the two got conflated.
 */
export function buildAgentArchitectSystemPrompt(repoRoot: string): string {
  const exemplars = collectExemplars(repoRoot);
  if (exemplars.length === 0) return ARCHITECT_SYSTEM_PROMPT_BASE;

  // An exemplar is an existing persona, and an existing persona may still
  // carry a grade or a pair this prompt has just told the model not to write.
  // Showing one anyway would contradict the instruction in the same message.
  const blocks = exemplars.map(
    (ex) =>
      `### Exemplar: ${ex.name}\n\n\`\`\`md\n${
        normalizeGeneratedPersona(ex.body).trim()
      }\n\`\`\``,
  );
  return `${ARCHITECT_SYSTEM_PROMPT_BASE}\n\n## Exemplars (existing personas — match this format)\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Removes what a generated persona is not allowed to decide for itself.
 *
 * Two things, for the same reason. A runtime pair, because the model doing the
 * authoring is not the model the Agent runs with, and copying it would pin the
 * Agent to whatever wrote it. A grade, because grades are no longer part of
 * authoring at all: nothing asks for one and nothing reads one from a new file.
 *
 * Enforced rather than merely requested: the authoring model writes whatever
 * it writes, and the file is what a run reads. A persona naming none of them is
 * returned untouched, so this can never rewrite a file it had no reason to —
 * and it is applied only to freshly generated personas, never to a persona
 * somebody already has on disk.
 */
export function normalizeGeneratedPersona(personaMarkdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(personaMarkdown);
  if (!match || !personaMarkdown.startsWith("---")) return personaMarkdown;
  const body = match[1] ?? "";
  const kept = body.split("\n").filter((line) => !declaresRemovedKey(line));
  if (kept.length === body.split("\n").length) return personaMarkdown;
  return `---\n${kept.join("\n")}\n---${personaMarkdown.slice(match[0].length)}`;
}

const REMOVED_PERSONA_KEYS = new Set(["provider", "model", "tier"]);

/**
 * Whether the persona loader would read this line as one of the removed keys.
 *
 * Deliberately the same rule `parseAgentFrontmatter` applies
 * (`parsers/load-agent.ts:49-52`): the first colon after at least one
 * character, a line that starts with neither a space nor `-`, and a trimmed
 * key. Matching only `tier: value` would leave `tier : strategic`, `tier:` and
 * `tier:strategic` in the file — each of which the loader still reads as a
 * grade, so the persona would look clean and load with one anyway.
 *
 * An indented line or a list item is nested content rather than a field, and is
 * left exactly where it is.
 */
function declaresRemovedKey(line: string): boolean {
  const colonIndex = line.indexOf(":");
  if (colonIndex <= 0 || line.startsWith(" ") || line.startsWith("-")) return false;
  return REMOVED_PERSONA_KEYS.has(line.slice(0, colonIndex).trim());
}

interface PersonaExemplar {
  name: string;
  body: string;
}

/**
 * Reads up to two existing agent personas from `agents/` as in-context
 * exemplars. Prefers `contrarian` (canonical strategic agent) and `editor`
 * (canonical specialist) when present; otherwise falls back to the first
 * two found alphabetically.
 */
function collectExemplars(repoRoot: string): PersonaExemplar[] {
  const agentsDir = path.join(repoRoot, "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const preferred = ["contrarian", "editor", "pragmatist", "innovator"];
  const found: PersonaExemplar[] = [];
  const seen = new Set<string>();

  for (const name of preferred) {
    const filePath = path.join(agentsDir, name, `${name}.md`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const body = fs.readFileSync(filePath, "utf8");
      found.push({ name, body });
      seen.add(name);
      if (found.length >= 2) return found;
    } catch {
      // skip
    }
  }

  if (found.length >= 2) return found;

  // Fallback: alphabetical scan for any agent with a top-level persona file.
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || seen.has(entry.name)) continue;
    const filePath = path.join(agentsDir, entry.name, `${entry.name}.md`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const body = fs.readFileSync(filePath, "utf8");
      found.push({ name: entry.name, body });
      if (found.length >= 2) break;
    } catch {
      // skip
    }
  }
  return found;
}

export function renderSkillsBlock(
  skills: Array<{ name: string; body: string }>,
): string {
  if (skills.length === 0) {
    return "## Selected skills\n\n(No skills selected.)\n";
  }
  const blocks = skills.map(
    (skill) =>
      `### Skill: ${skill.name}\n\n\`\`\`md\n${skill.body.trim()}\n\`\`\``,
  );
  return `## Selected skills (each becomes a skills/<name>/ subfolder under the new agent)\n\n${blocks.join("\n\n")}\n`;
}
