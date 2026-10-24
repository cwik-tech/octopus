/**
 * Team Runtime — Global Teams Registry Parser
 *
 * Parses a named `teams.yaml` registry of reusable callable agents and teams.
 * This registry is separate from a local team's `team.yaml` roster and exists
 * to support future dynamic spawn/discovery features.
 */

import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { parseYaml, type YamlObject, type YamlValue } from '../core/yaml-parser.js'
import type { RegistryEntry } from '../core/types.js'
import { parseToolList } from '../core/tool-policy.js'

export interface TeamRegistryParseResult {
  entries: RegistryEntry[]
  errors: string[]
  warnings: string[]
}

function str(val: YamlValue | undefined, fallback: string): string {
  if (val == null) return fallback
  return String(val)
}

function resolvePath(baseDir: string, p: string): string {
  if (!p) return p
  if (p.startsWith('~')) return path.join(homedir(), p.slice(1))
  if (path.isAbsolute(p)) return p
  return path.resolve(baseDir, p)
}

function parseStringList(val: YamlValue | undefined): string[] | undefined {
  if (!Array.isArray(val)) return undefined
  return val.map((item) => String(item)).filter(Boolean)
}

function parseMounts(raw: YamlValue[] | undefined): Array<{ from: string; to: string }> | undefined {
  if (!raw) return undefined
  return raw.map((m) => {
    const mount = m as YamlObject
    return { from: str(mount.from, ''), to: str(mount.to, '') }
  })
}

export function parseTeamRegistry(filePath: string): TeamRegistryParseResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return { entries: [], errors: [`Cannot read registry file: ${filePath}`], warnings: [] }
  }

  const baseDir = path.dirname(path.resolve(filePath))
  const raw = parseYaml(content)
  const errors: string[] = []
  const warnings: string[] = []
  const entries: RegistryEntry[] = []

  for (const [name, value] of Object.entries(raw)) {
    const entry = value as YamlObject
    const type = str(entry.type, 'team') as 'agent' | 'team'
    const description = entry.description ? str(entry.description, '') : undefined
    const tags = parseStringList(entry.tags)

    if (type === 'team') {
      const teamPath = resolvePath(baseDir, str(entry.team_path, ''))
      if (!teamPath) {
        errors.push(`Registry entry '${name}': team entries require 'team_path'`)
        continue
      }
      if (!fs.existsSync(teamPath)) {
        warnings.push(`Registry entry '${name}': team_path does not exist at parse time: ${teamPath}`)
      }
      entries.push({
        name,
        type: 'team',
        ...whenDefined(description, (definedValue) => ({ description: definedValue })),
        ...whenDefined(tags, (definedValue) => ({ tags: definedValue })),
        team_path: teamPath,
        ...whenDefined(entry.input_artifact ? str(entry.input_artifact, '') : undefined, (definedValue) => ({ input_artifact: definedValue })),
        ...whenDefined(entry.output_artifact ? str(entry.output_artifact, '') : undefined, (definedValue) => ({ output_artifact: definedValue })),
        ...whenDefined(entry.requested_capability ? str(entry.requested_capability, '') : undefined, (definedValue) => ({ requested_capability: definedValue })),
        ...whenDefined(parseMounts(entry.mount as YamlValue[] | undefined), (definedValue) => ({ mount: definedValue })),
        ...whenDefined(entry.host_model ? str(entry.host_model, '') : undefined, (definedValue) => ({ host_model: definedValue })),
        ...whenDefined(entry.host_provider ? str(entry.host_provider, '') : undefined, (definedValue) => ({ host_provider: definedValue })),
      })
      continue
    }

    // Read, never judged. Dropping the entry over a retired label would take
    // the Agent out of the library altogether — it would stop appearing and
    // stop being addable to a Team — for a word nothing reads. It is reported
    // through the warnings channel instead, so the setting is named rather
    // than silently obeyed or silently discarded (§5).
    const retiredTier = typeof entry.tier === 'string' ? entry.tier : undefined
    if (retiredTier !== undefined) {
      warnings.push(
        `Registry entry '${name}' declares tier '${retiredTier}'. It is ignored: ` +
          `the entry's role says how the Agent is used, and the Agent runs with its ` +
          `own provider/model or with the application default.`,
      )
    }

    const agentFile = resolvePath(baseDir, str(entry.agent_file, ''))
    if (!agentFile) {
      errors.push(`Registry entry '${name}': agent entries require 'agent_file'`)
      continue
    }
    if (!fs.existsSync(agentFile)) {
      warnings.push(`Registry entry '${name}': agent_file does not exist at parse time: ${agentFile}`)
    }

    entries.push({
      name,
      type: 'agent',
      ...whenDefined(description, (definedValue) => ({ description: definedValue })),
      ...whenDefined(tags, (definedValue) => ({ tags: definedValue })),
      role: str(entry.role, ''),
      ...whenDefined(retiredTier, (tier) => ({ tier })),
      agent_file: agentFile,
      ...whenDefined(parseToolList(entry.tools), (definedValue) => ({ tools: definedValue })),
      ...whenDefined(entry.model ? str(entry.model, '') : undefined, (definedValue) => ({ model: definedValue })),
      ...whenDefined(entry.provider ? str(entry.provider, '') : undefined, (definedValue) => ({ provider: definedValue })),
      ...whenDefined(entry.provider_config ? (entry.provider_config as Record<string, unknown>) : undefined, (definedValue) => ({ provider_config: definedValue })),
    })
  }

  return { entries, errors, warnings }
}
