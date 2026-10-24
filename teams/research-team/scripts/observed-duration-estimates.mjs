import * as fs from 'node:fs'
import * as path from 'node:path'

export const RESEARCH_FLOOR_MS = 90_000
export const SYNTHESIS_FLOOR_MS = 90_000
export const CRITIC_FLOOR_MS = 120_000
export const RESEARCH_FALLBACK_MS = 300_000
export const SYNTHESIS_FALLBACK_MS = 240_000
export const CRITIC_FALLBACK_MS = 180_000

const OBSERVED_DURATION_PADDING = 1.25
const MAX_AGENT_RUN_LOG_BYTES = 2 * 1024 * 1024

export function estimateDurationMs(observedMs, { fallbackMs, floorMs }) {
  if (!Number.isFinite(observedMs) || observedMs <= 0) return fallbackMs
  return Math.max(floorMs, observedMs * OBSERVED_DURATION_PADDING)
}

export function observedAgentDurationMs(logPath, agentName) {
  let durationMs
  for (const entry of readAgentRunEntries(logPath)) {
    if (
      entry.agent_name !== agentName ||
      entry.event !== 'end' ||
      entry.status !== 'completed' ||
      !Number.isFinite(entry.duration_ms) ||
      entry.duration_ms <= 0
    ) {
      continue
    }
    durationMs = entry.duration_ms
  }
  return durationMs
}

export function observedResearchSpanMs(evidenceDirectory) {
  try {
    const evidenceStats = fs.lstatSync(evidenceDirectory)
    if (evidenceStats.isSymbolicLink() || !evidenceStats.isDirectory()) return undefined
    const logPath = latestWaveAgentRunLog(evidenceDirectory)
    if (!logPath) return undefined
    return researchRunSpanMs(readAgentRunEntries(logPath))
  } catch {
    return undefined
  }
}

function latestWaveAgentRunLog(evidenceDirectory) {
  const waveNumbers = fs
    .readdirSync(evidenceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^wave-(\d+)$/u.exec(entry.name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
  if (waveNumbers.length === 0) return undefined
  return path.join(
    evidenceDirectory,
    `wave-${Math.max(...waveNumbers)}`,
    'logs',
    'agent-runs.jsonl',
  )
}

function researchRunSpanMs(entries) {
  let firstStartMs = Infinity
  let lastTerminalMs = -Infinity
  for (const entry of entries) {
    if (entry.agent_name !== 'web-researcher') continue
    const timestampMs = Date.parse(entry.timestamp)
    if (!Number.isFinite(timestampMs)) continue
    if (entry.event === 'start') firstStartMs = Math.min(firstStartMs, timestampMs)
    if (entry.event === 'end' || entry.event === 'fail') {
      lastTerminalMs = Math.max(lastTerminalMs, timestampMs)
    }
  }
  if (lastTerminalMs <= firstStartMs) return undefined
  return lastTerminalMs - firstStartMs
}

function readAgentRunEntries(filePath) {
  try {
    const stats = fs.lstatSync(filePath)
    if (stats.isSymbolicLink() || !stats.isFile()) return []
    if (stats.size > MAX_AGENT_RUN_LOG_BYTES) return []
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .flatMap((line) => parsedJsonLine(line))
  } catch {
    return []
  }
}

function parsedJsonLine(line) {
  try {
    const entry = JSON.parse(line)
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? [entry] : []
  } catch {
    return []
  }
}
