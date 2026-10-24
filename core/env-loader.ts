import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

let loaded = false

export function loadDotEnv(cwd = process.cwd()): void {
  if (loaded) return
  loaded = true

  for (const candidate of getEnvCandidates(cwd)) {
    if (!fs.existsSync(candidate)) continue
    applyEnvFile(candidate)
  }
}

function getEnvCandidates(cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd)
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const candidates = [
    path.join(resolvedCwd, '.env'),
    path.join(repoRoot, '.env'),
  ]
  return [...new Set(candidates)]
}

function applyEnvFile(filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line
    const separator = normalized.indexOf('=')
    if (separator <= 0) continue

    const key = normalized.slice(0, separator).trim()
    if (!key || process.env[key] !== undefined) continue

    let value = normalized.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }

  // Normalize common alias used in local setups so Anthropic-backed paths
  // consistently key off ANTHROPIC_API_KEY.
  if (process.env.ANTHROPIC_API_KEY === undefined && process.env.CLAUDE_API_KEY) {
    process.env.ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY
  }
}
