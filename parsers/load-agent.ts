/**
 * Agent Loading — Parse agent files and build LoadedAgent with template injection.
 *
 * Extracted from index.ts to enable unit testing of template variable injection
 * ({{PRODUCES_ARTIFACTS}}, {{CONSUMES_ARTIFACTS}}, etc.)
 */

import { whenDefined } from '../core/optional-properties.js'
import { CHAT_VISUALIZATION_POLICY } from '../core/chat-visualization-policy.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { TeamConfig, LoadedAgent, AgentRosterEntry, ThinkingLevel } from '../core/types.js'
import { readThinkingLevel } from '../core/types.js'
import { getRuntimeDefaultEffort } from '../domains/provider/default-effort-selection.js'
import { parseToolList } from '../core/tool-policy.js'
import { readWorkflowModelSelection } from '../domains/provider/workflow-model-selection.js'
import { getRuntimeDefaultModelState } from '../domains/provider/default-model-selection.js'
import {
  readAgentModelChoice,
  resolveAgentModelChoice,
  type AgentModelChoiceReading,
  type AgentModelDiagnostic,
  type ModelSelection,
  type ModelSelectionError,
} from '../contracts/agent-model-selection.js'
import {
  frontmatterString,
  parseMarkdownFrontmatter,
} from '../core/markdown-frontmatter.js'

/**
 * The level this agent file asks for.
 *
 * An absent setting means the one application-wide default, which Settings owns
 * and which is `medium` until somebody changes it. So widening the vocabulary
 * moved no agent, and changing the setting moves exactly the agents that never
 * named a level. `provider-default` is how an Agent asks for no setting at all;
 * it can be written in the file, and it can also be the application default, in
 * which case the Agents that name nothing inherit it like any other choice.
 *
 * A value outside the vocabulary still falls back to the default. It is not a
 * level a person chose from anywhere this application offers; whether a chosen
 * level is one this provider and model accept is a different question, decided
 * against what the provider publishes and reported rather than substituted
 * (`domains/provider/effort-support.ts`).
 */
function parseThinkingLevel(value: string | undefined): ThinkingLevel {
  // Asked now, not captured at import: Settings owns this default, and an
  // Agent that names no level has to follow a change to it on its next load
  // rather than after a restart.
  return readThinkingLevel(value, getRuntimeDefaultEffort())
}

/**
 * Parse YAML-style frontmatter from an agent markdown file.
 * Returns the frontmatter key-value pairs and the body content.
 */
export function parseAgentFrontmatter(filePath: string): { frontmatter: Record<string, string>; body: string } {
  const content = fs.readFileSync(filePath, 'utf-8')
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }
  const frontmatterSource = match[1]
  const body = match[2]
  if (frontmatterSource === undefined || body === undefined) {
    return { frontmatter: {}, body: content }
  }

  const fm: Record<string, string> = {}
  for (const line of frontmatterSource.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return { frontmatter: fm, body }
}

/** Keys that would put a secret in repository content. */
const CREDENTIAL_OPTION_KEYS = [
  'api_key',
  'apikey',
  'authorization',
  'auth_token',
  'access_token',
  'bearer',
  'password',
  'secret',
  'token',
]

/**
 * The provider settings an agent declares for its own provider.
 *
 * A single JSON object on one frontmatter line: this file's parser is
 * line-based, and nesting the authoring format would be a larger change than
 * the setting is worth. Values are plain scalars — a nested structure is not a
 * provider setting this build knows how to pass, and accepting one would mean
 * forwarding something unvalidated to an adapter.
 *
 * Credentials are refused outright. An agent file is repository content: it
 * gets copied, generated, committed and shared, and connection secrets live in
 * their own settings boundary.
 */
/**
 * Exported because every surface that lets an Agent carry provider settings has
 * to read them the same way. A second reader would let one path accept what
 * another refuses.
 */
export function readAgentProviderOptions(raw: string | undefined): {
  /**
   * Scalars, because that is what this function proves. Returning `unknown`
   * would make every caller re-assert what was already checked here.
   */
  options: Record<string, string | number | boolean>
  diagnostics: AgentModelDiagnostic[]
} {
  const source = raw?.trim()
  if (!source) return { options: {}, diagnostics: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return {
      options: {},
      diagnostics: [{
        code: 'invalid-provider-options',
        message:
          "'provider_options' must be one JSON object of plain provider settings. It is ignored.",
      }],
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      options: {},
      diagnostics: [{
        code: 'invalid-provider-options',
        message:
          "'provider_options' must be one JSON object of plain provider settings. It is ignored.",
      }],
    }
  }
  const options: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (CREDENTIAL_OPTION_KEYS.includes(key.toLowerCase())) {
      return {
        options: {},
        diagnostics: [{
          code: 'provider-options-credential',
          message:
            `'provider_options' names '${key}'. Credentials belong in Settings, never in an agent file. All options are ignored.`,
        }],
      }
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return {
        options: {},
        diagnostics: [{
          code: 'invalid-provider-options',
          message:
            `'provider_options.${key}' is not a plain provider setting. All options are ignored.`,
        }],
      }
    }
    options[key] = value
  }
  return { options, diagnostics: [] }
}

function buildSkillCatalog(skillsDir: string): string {
  if (!fs.existsSync(skillsDir)) return ''

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const skillPath = path.join(skillsDir, entry.name, 'SKILL.md')
      if (!fs.existsSync(skillPath)) return []
      const content = fs.readFileSync(skillPath, 'utf-8')
      const { metadata } = parseMarkdownFrontmatter(content)
      const name = frontmatterString(metadata.name) ?? entry.name
      const description = frontmatterString(metadata.description) ?? 'No description provided.'
      const version = typeof metadata.version === 'string' || typeof metadata.version === 'number'
        ? String(metadata.version)
        : undefined
      const sha256 = createHash('sha256').update(content).digest('hex')

      return [{ name, description, version, skillPath, sha256 }]
    })

  if (entries.length === 0) return ''

  const lines = [
    '## Available skills',
    '',
    'Skill instructions are loaded progressively. When the current task requires a skill, call `mcp__pipeline_skills__load_skill` with its exact `source` and `sha256`, then load only the linked resources needed for that task.',
  ]
  for (const entry of entries) {
    lines.push('', `### ${entry.name}`, `description: ${entry.description}`)
    if (entry.version) lines.push(`version: ${entry.version}`)
    lines.push(`source: ${entry.skillPath}`, `sha256: ${entry.sha256}`)
  }
  return lines.join('\n')
}

/**
 * Resolve the effective provider/model for an agent.
 *
 * Precedence is explicit roster override -> the agent persona's own
 * frontmatter -> team tier config -> team default provider -> app-wide default
 * model (Settings → AI Providers) -> built-in sentinel. An agent that declares
 * its own provider keeps it, so the Agents page and the Team roster can never
 * disagree about what will run; the models-by-tier table supplies the runtime
 * for agents that declare none.
 *
 * `resolveAgentRuntime` owns both the layering and the app-default fallback,
 * and the Team roster calls it too, so what the roster shows is what runs.
 */
interface AgentRuntimeSelection {
  readonly provider: string
  readonly model: string
  readonly selection: ModelSelection | null
  readonly selectionError?: ModelSelectionError
  readonly selectionDiagnostics?: readonly AgentModelDiagnostic[]
}

/**
 * The agent's own choice, or the one application default. Team membership,
 * roster overrides, and tier tables are deliberately not inputs: an agent runs
 * with what its own file says, or with the default the user picked once in
 * Settings. A workflow task carrying its chat's concrete selection overrides
 * these saved choices for that task and its delegated workers only.
 *
 * A failure is reported, never patched over. Preflight turns it into a startup
 * error so the user learns which selection is broken instead of silently
 * getting a different model.
 */
function selectAgentRuntimeModel(raw: {
  provider?: string | undefined
  model?: string | undefined
}): AgentRuntimeSelection {
  const workflowModel = readWorkflowModelSelection()
  if (workflowModel) {
    return {
      ...workflowModel,
      selection: { ...workflowModel, source: 'user', reason: 'explicit-user-choice' },
    }
  }
  const reading: AgentModelChoiceReading = readAgentModelChoice(raw)
  const diagnostics =
    reading.diagnostics.length > 0
      ? { selectionDiagnostics: reading.diagnostics }
      : {}
  if (!reading.choice) {
    return {
      provider: '',
      model: '',
      selection: null,
      ...whenDefined(reading.error, (selectionError) => ({ selectionError })),
      ...diagnostics,
    }
  }
  // The agent's *configured* selection. A user-approved retry is not a
  // configuration and is deliberately not applied here: it covers one
  // invocation, and only the dispatch knows which invocation it is running.
  const result = resolveAgentModelChoice(
    reading.choice,
    getRuntimeDefaultModelState(),
  )
  if (!result.ok) {
    return {
      provider: '',
      model: '',
      selection: null,
      selectionError: result.error,
      ...diagnostics,
    }
  }
  return {
    provider: result.selection.provider,
    model: result.selection.model,
    selection: result.selection,
    ...diagnostics,
  }
}

/**
 * Load an agent from its roster entry and agent file.
 *
 * Reads the agent's markdown file, parses frontmatter for fallback metadata,
 * loads experience/skills/knowledge from subdirectories, and injects template variables
 * into the system prompt:
 *   - {{KNOWLEDGE_BLOCK}}, {{EXPERIENCE_BLOCK}}, {{SKILLS_BLOCK}}
 *   - {{PRODUCES_ARTIFACTS}}, {{CONSUMES_ARTIFACTS}}
 */
export function loadAgent(
  rosterEntry: AgentRosterEntry,
  teamConfig: TeamConfig,
  defaultColor: number,
): LoadedAgent | undefined {
  const experienceEnabled = rosterEntry.experience_enabled ?? true

  if (rosterEntry.type === 'team') {
    // A team-type entry is a nested team, not a persona, so it has no prompt
    // file. Its declared host settings decide its model, and the app default
    // covers an entry that declares none.
    const resolved = selectAgentRuntimeModel({
      provider: rosterEntry.host_provider,
      model: rosterEntry.host_model,
    })
    return {
      name: rosterEntry.name,
      model: resolved.model,
      thinking: getRuntimeDefaultEffort(),
      ...whenDefined(rosterEntry.tools, (tools) => ({ tools })),
      systemPrompt: '',
      experienceContent: '',
      experienceEnabled,
      skillsContent: '',
      knowledgeContent: '',
      agentDir: rosterEntry.team_path || '',
      color: rosterEntry.color ?? defaultColor,
      provider: resolved.provider,
      selection: resolved.selection,
      ...whenDefined(resolved.selectionError, (selectionError) => ({ selectionError })),
      ...whenDefined(resolved.selectionDiagnostics, (selectionDiagnostics) => ({
        selectionDiagnostics,
      })),
    }
  }

  const agentPath = rosterEntry.agent_file
  if (!agentPath || !fs.existsSync(agentPath)) return undefined

  const { frontmatter, body } = parseAgentFrontmatter(agentPath)
  const name = rosterEntry.name
  const resolved = selectAgentRuntimeModel({
    provider: frontmatter.provider,
    model: frontmatter.model,
  })
  const providerOptions = readAgentProviderOptions(
    resolved.selection?.source === 'user' ? undefined : frontmatter.provider_options,
  )
  const model = resolved.model
  const thinking = parseThinkingLevel(frontmatter.thinking)
  const tools = rosterEntry.tools ?? parseToolList(frontmatter.tools)

  // Load experience files
  let experienceContent = ''
  const agentDir = path.dirname(agentPath)
  const experienceDir = path.join(agentDir, 'experience')
  if (experienceEnabled && fs.existsSync(experienceDir)) {
    const files = fs.readdirSync(experienceDir).filter((f) => f.endsWith('.md'))
    for (const f of files) {
      experienceContent += fs.readFileSync(path.join(experienceDir, f), 'utf-8') + '\n'
    }
  }

  // Discover skill metadata without eagerly injecting full instruction bodies.
  const skillsDir = path.join(agentDir, 'skills')
  const skillsContent = buildSkillCatalog(skillsDir)

  // Load knowledge files (supports flat .md files and category subdirs: industry/, function/, company/, topic/)
  let knowledgeContent = ''
  const knowledgeDir = path.join(agentDir, 'knowledge')
  if (fs.existsSync(knowledgeDir)) {
    const entries = fs.readdirSync(knowledgeDir, { withFileTypes: true })
    // Load top-level .md files
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        knowledgeContent += fs.readFileSync(path.join(knowledgeDir, entry.name), 'utf-8') + '\n---\n'
      }
    }
    // Recurse one level into category subdirs
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(knowledgeDir, entry.name)
        const subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.md'))
        for (const f of subFiles) {
          knowledgeContent += fs.readFileSync(path.join(subDir, f), 'utf-8') + '\n---\n'
        }
      }
    }
  }

  // Build system prompt with injected blocks
  let systemPrompt = body
  systemPrompt = systemPrompt.replaceAll('{{KNOWLEDGE_BLOCK}}', knowledgeContent || '_No domain knowledge loaded._')
  systemPrompt = systemPrompt.replaceAll('{{EXPERIENCE_BLOCK}}', experienceContent || '_No experience accumulated yet._')
  systemPrompt = systemPrompt.replaceAll('{{SKILLS_BLOCK}}', skillsContent || '_No skills loaded._')
  const producesStr = rosterEntry.produces?.map(a => a.path).join(', ') || ''
  const consumesStr = rosterEntry.consumes?.map(a => a.path).join(', ') || ''
  systemPrompt = systemPrompt.replaceAll('{{PRODUCES_ARTIFACTS}}', producesStr)
  systemPrompt = systemPrompt.replaceAll('{{CONSUMES_ARTIFACTS}}', consumesStr)
  systemPrompt = systemPrompt.replaceAll('{{ALLOWED_TOOLS}}', tools ? tools.join(', ') : '')

  return {
    name,
    model,
    thinking,
    ...whenDefined(tools, (presentTools) => ({ tools: presentTools })),
    systemPrompt: `${systemPrompt}\n\n${CHAT_VISUALIZATION_POLICY}`,
    experienceContent,
    experienceEnabled,
    skillsContent,
    knowledgeContent,
    agentDir,
    color: rosterEntry.color ?? defaultColor,
    provider: resolved.provider,
    // The agent's own options, for the agent's own provider. A team
    // contributes none, and none are carried onto a provider the agent did not
    // choose: an approved retry runs on the application default, which may be
    // another vendor whose API these settings do not describe.
    providerConfig:
      resolved.selection?.source === 'agent' ? providerOptions.options : {},
    selection: resolved.selection,
    ...whenDefined(resolved.selectionError, (selectionError) => ({ selectionError })),
    ...(resolved.selectionDiagnostics || providerOptions.diagnostics.length > 0
      ? {
          selectionDiagnostics: [
            ...(resolved.selectionDiagnostics ?? []),
            ...providerOptions.diagnostics,
          ],
        }
      : {}),
  }
}
