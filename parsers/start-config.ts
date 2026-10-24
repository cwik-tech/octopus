/**
 * Team Runtime — Start Config Parser
 *
 * Parses a lightweight `start.yaml` launcher file that selects the default
 * registry entry to boot from `teams.yaml`.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { parseYaml, type YamlValue } from '../core/yaml-parser.js'

export interface StartConfig {
  entry: string
  registry?: string
}

export interface StartConfigParseResult {
  config: StartConfig | null
  errors: string[]
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

export function parseStartConfig(filePath: string): StartConfigParseResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return { config: null, errors: [`Cannot read ${filePath}`] }
  }

  const baseDir = path.dirname(path.resolve(filePath))
  const raw = parseYaml(content)
  const entry = str(raw.entry, '')
  if (!entry) {
    return { config: null, errors: [`Missing required field: entry in ${filePath}`] }
  }

  return {
    config: {
      entry,
      ...whenDefined(raw.registry ? resolvePath(baseDir, str(raw.registry, '')) : undefined, (registry) => ({ registry })),
    },
    errors: [],
  }
}
import { whenDefined } from '../core/optional-properties.js'
