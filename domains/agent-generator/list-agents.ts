/**
 * Scans `agents/` and returns a summary for each agent folder.
 *
 * An agent folder is recognised by having a `<name>/<name>.md` persona file.
 * The persona frontmatter's `description` field (if present) is exposed as the
 * library row's secondary text. The skill subfolder names under
 * `skills/<skill>/` are exposed for duplicate detection.
 */

import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  AgentAssetCounts,
  AgentAssetFile,
  AgentAssetKind,
  AgentDetail,
  AgentSkillDetail,
  AgentSummary,
} from './types.js'
import { listAgentTeamUsage } from './team-usage.js'
import { parseAgentFrontmatter } from '../../parsers/load-agent.js'
import {
  frontmatterString,
  parseMarkdownFrontmatter,
} from '../../core/markdown-frontmatter.js'
import { parseToolList } from '../../core/tool-policy.js'
import { isAgentHiddenFromUi, isSystemAgent } from './agent-visibility.js'

function frontmatterHasBrowser(frontmatter: Record<string, string>): boolean {
  return parseToolList(frontmatter.tools)?.includes('browser') ?? false
}

export function listAgents(repoRoot: string): AgentSummary[] {
  const agentsDir = path.join(repoRoot, 'agents')
  if (!fs.existsSync(agentsDir)) return []
  const usage = listAgentTeamUsage(repoRoot)

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  const agents: AgentSummary[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (name.startsWith('.')) continue
    const personaPath = path.join(agentsDir, name, `${name}.md`)
    if (!fs.existsSync(personaPath)) continue

    let frontmatter: Record<string, string> = {}
    try {
      frontmatter = parseAgentFrontmatter(personaPath).frontmatter
    } catch {
      frontmatter = {}
    }

    const skills = listSkillNames(path.join(agentsDir, name, 'skills'))

    agents.push({
      name,
      ...whenDefined(stringOrUndefined(frontmatter.description), (definedValue) => ({ description: definedValue })),
      ...whenDefined(stringOrUndefined(frontmatter.tier), (definedValue) => ({ tier: definedValue })),
      ...whenDefined(stringOrUndefined(frontmatter.model), (definedValue) => ({ model: definedValue })),
      ...whenDefined(stringOrUndefined(frontmatter.provider), (definedValue) => ({ provider: definedValue })),
      ...whenDefined(stringOrUndefined(frontmatter.thinking), (definedValue) => ({ thinking: definedValue })),
      skills,
      usedInTeams: usage.get(name) ?? [],
      browserEnabled: frontmatterHasBrowser(frontmatter),
      uiHidden: isAgentHiddenFromUi(frontmatter),
      system: isSystemAgent(frontmatter),
    })
  }

  agents.sort((a, b) => a.name.localeCompare(b.name))
  return agents
}

export function readAgentDetail(repoRoot: string, agentName: string): AgentDetail {
  const name = sanitizeAgentName(agentName)
  if (!name) throw new Error('agentName must be a non-empty kebab-case identifier')

  const agentDir = path.join(repoRoot, 'agents', name)
  const personaPath = path.join(agentDir, `${name}.md`)
  if (!fs.existsSync(personaPath)) {
    throw new Error(`Persona file does not exist: ${personaPath}`)
  }

  const personaMarkdown = fs.readFileSync(personaPath, 'utf-8')
  let frontmatter: Record<string, string> = {}
  try {
    frontmatter = parseAgentFrontmatter(personaPath).frontmatter
  } catch {
    frontmatter = {}
  }

  const summary = listAgents(repoRoot).find((agent) => agent.name === name)
  const assets = listAgentAssets(repoRoot, agentDir, name)
  const skillDetails = listSkillDetails(repoRoot, agentDir, assets)
  const counts = countAssets(skillDetails, assets)

  return {
    name,
    ...whenDefined(stringOrUndefined(frontmatter.description), (description) => ({ description })),
    ...whenDefined(stringOrUndefined(frontmatter.tier), (tier) => ({ tier })),
    ...whenDefined(stringOrUndefined(frontmatter.model), (model) => ({ model })),
    ...whenDefined(stringOrUndefined(frontmatter.provider), (provider) => ({ provider })),
    ...whenDefined(stringOrUndefined(frontmatter.thinking), (thinking) => ({ thinking })),
    skills: skillDetails.map((skill) => skill.name).sort(),
    usedInTeams: summary?.usedInTeams ?? [],
    browserEnabled: frontmatterHasBrowser(frontmatter),
    uiHidden: isAgentHiddenFromUi(frontmatter),
    system: isSystemAgent(frontmatter),
    personaMarkdown,
    personaPath: toRepoRelative(repoRoot, personaPath),
    agentPath: toRepoRelative(repoRoot, agentDir),
    frontmatter,
    skillDetails,
    assets,
    counts,
  }
}

function listSkillNames(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md')
    if (fs.existsSync(skillMd)) names.push(entry.name)
  }
  names.sort()
  return names
}

function listSkillDetails(
  repoRoot: string,
  agentDir: string,
  assets: AgentAssetFile[],
): AgentSkillDetail[] {
  const skillsDir = path.join(agentDir, 'skills')
  if (!fs.existsSync(skillsDir)) return []

  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: AgentSkillDetail[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillDir = path.join(skillsDir, entry.name)
    const skillMd = path.join(skillDir, 'SKILL.md')
    if (!fs.existsSync(skillMd)) continue

    let description: string | undefined
    try {
      const parsed = parseMarkdownFrontmatter(fs.readFileSync(skillMd, 'utf-8'))
      description = frontmatterString(parsed.metadata.description)
        ?? firstBodyParagraph(parsed.body)
    } catch {
      description = undefined
    }

    const prefix = `skills/${entry.name}/`
    const files = assets.filter((asset) => asset.agentPath.startsWith(prefix))

    skills.push({
      name: entry.name,
      path: toRepoRelative(repoRoot, skillMd),
      ...whenDefined(description, (definedValue) => ({ description: definedValue })),
      files,
      templateCount: files.filter((file) => file.kind === 'template').length,
      referenceCount: files.filter((file) => file.kind === 'reference').length,
      scriptCount: files.filter((file) => file.kind === 'script').length,
    })
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

function listAgentAssets(
  repoRoot: string,
  agentDir: string,
  agentName: string,
): AgentAssetFile[] {
  const assets: AgentAssetFile[] = []
  collectFiles(agentDir, agentDir, repoRoot, agentName, assets)
  assets.sort((a, b) => a.agentPath.localeCompare(b.agentPath))
  return assets
}

function collectFiles(
  rootDir: string,
  currentDir: string,
  repoRoot: string,
  agentName: string,
  assets: AgentAssetFile[],
): void {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const absPath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(rootDir, absPath, repoRoot, agentName, assets)
      continue
    }
    if (!entry.isFile()) continue

    const agentPath = normalizePath(path.relative(rootDir, absPath))
    if (agentPath === `${agentName}.md`) continue

    const stat = fs.statSync(absPath)
    assets.push({
      path: toRepoRelative(repoRoot, absPath),
      agentPath,
      kind: classifyAsset(agentPath),
      sizeBytes: stat.size,
    })
  }
}

function classifyAsset(agentPath: string): AgentAssetKind {
  const parts = agentPath.split('/')
  if (parts[0] === 'experience') return 'experience'
  if (parts[0] === 'knowledge') return 'knowledge'
  if (parts.includes('templates')) return 'template'
  if (parts.includes('references')) return 'reference'
  if (parts.includes('scripts')) return 'script'
  if (parts[0] === 'skills') return 'skill'
  return 'other'
}

function countAssets(
  skillDetails: AgentSkillDetail[],
  assets: AgentAssetFile[],
): AgentAssetCounts {
  return {
    skills: skillDetails.length,
    templates: assets.filter((asset) => asset.kind === 'template').length,
    references: assets.filter((asset) => asset.kind === 'reference').length,
    scripts: assets.filter((asset) => asset.kind === 'script').length,
    experience: assets.filter((asset) => asset.kind === 'experience').length,
    knowledge: assets.filter((asset) => asset.kind === 'knowledge').length,
    other: assets.filter((asset) => asset.kind === 'other').length,
  }
}

function toRepoRelative(repoRoot: string, absPath: string): string {
  return normalizePath(path.relative(repoRoot, absPath))
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function stringOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function firstBodyParagraph(body: string): string | undefined {
  const lines = body.split('\n').map((line) => line.trim())
  for (const line of lines) {
    if (!line || line.startsWith('#') || line.startsWith('---')) continue
    return line.length > 180 ? `${line.slice(0, 177)}...` : line
  }
  return undefined
}

function sanitizeAgentName(input: string): string {
  const trimmed = (input || '').trim().toLowerCase()
  return trimmed.replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '')
}
