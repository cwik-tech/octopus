import type { AgentProviderHealth, TeamBuilderHealth } from './agent-generator.js'
import type { ProviderErrorKind } from './provider.js'

/**
 * One vocabulary for "something is wrong with this agent or this Team".
 *
 * Before this contract the app had two health subsystems and three icon
 * styles: an agent row drew one icon from a raw provider string, a Team row
 * drew a different icon from two arrays of English, and the agent editor drew
 * a third. None of them could say *what kind* of wrong, so nothing downstream
 * could offer the right next step — "add a key" and "wait for the rate limit
 * to reset" arrived looking identical.
 *
 * A `Diagnostic` separates the three questions a reader actually has. The
 * severity decides the icon. The kind decides the advice. The subject names
 * who it is about, so a Team-level badge can say which of its members is the
 * problem.
 */

export type DiagnosticSeverity = 'error' | 'warning'

/**
 * Why something is unhealthy.
 *
 * `ProviderErrorKind` covers everything a provider itself can report, so a
 * runtime failure and a health ping classify into the same closed list. Two
 * kinds are added for faults that belong to this repository rather than to a
 * provider:
 *
 * - `config` — the machine or the configuration is missing something the run
 *   needs, such as an API key or a provider connection.
 * - `structure` — a `team.yaml` says something impossible or incomplete.
 *
 * `configuration` from `ProviderErrorKind` means the *provider's* settings are
 * wrong as the provider sees them. The health layer never emits it; a
 * configuration fault this app can see is always `config`.
 */
export type DiagnosticKind = ProviderErrorKind | 'config' | 'structure'

/** Who a diagnostic is about. Every field is optional and none is invented. */
export interface DiagnosticSubject {
  agentName?: string | undefined
  teamName?: string | undefined
  provider?: string | undefined
  model?: string | undefined
}

export interface Diagnostic {
  severity: DiagnosticSeverity
  kind: DiagnosticKind
  /**
   * The whole sentence a person reads, already naming its subject.
   *
   * Built where the fault is found rather than assembled at the badge, so the
   * same string is correct in a tooltip, a log line, and a chat reply.
   */
  message: string
  subject: DiagnosticSubject
}

/**
 * `unknown` is not a fourth severity: it is the absence of an answer.
 *
 * A provider that was never reachable enough to check is not failing and is
 * not fine, and drawing it in the failing colour taught people to ignore the
 * colour. It gets its own quiet state.
 */
export type HealthStatus = 'ok' | 'warning' | 'error' | 'unknown'

/** What one badge draws: one status, and the reasons behind it. */
export interface HealthSummary {
  status: HealthStatus
  diagnostics: Diagnostic[]
}

const HEALTHY: HealthSummary = { status: 'ok', diagnostics: [] }

/** The status a set of diagnostics earns on its own. */
export function healthStatusFromDiagnostics(
  diagnostics: readonly Diagnostic[],
): 'ok' | 'warning' | 'error' {
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return 'error'
  }
  return diagnostics.length > 0 ? 'warning' : 'ok'
}

/**
 * One agent's provider reachability, as a badge reads it.
 *
 * Falls back to the pre-diagnostic fields when the payload carries none, so a
 * renderer talking to an older API still shows the state rather than nothing.
 */
export function summarizeAgentProviderHealth(
  health: AgentProviderHealth | undefined,
): HealthSummary {
  if (!health) return HEALTHY
  const diagnostics = health.diagnostics ?? legacyAgentDiagnostics(health)
  return { status: health.status, diagnostics }
}

/** One Team's configuration and provider readiness, as a badge reads it. */
export function summarizeTeamBuilderHealth(
  health: TeamBuilderHealth | undefined,
): HealthSummary {
  if (!health) return HEALTHY
  const diagnostics = health.diagnostics ?? legacyTeamDiagnostics(health)
  return { status: health.status, diagnostics }
}

function legacyAgentDiagnostics(health: AgentProviderHealth): Diagnostic[] {
  if (health.status === 'ok') return []
  return [
    {
      severity: health.status === 'error' ? 'error' : 'warning',
      kind: 'unknown',
      message:
        health.message ??
        (health.status === 'error'
          ? `Agent '${health.agentName}' cannot reach its provider.`
          : `Agent '${health.agentName}' provider status could not be determined.`),
      subject: {
        agentName: health.agentName,
        provider: health.provider,
        model: health.model,
      },
    },
  ]
}

function legacyTeamDiagnostics(health: TeamBuilderHealth): Diagnostic[] {
  const diagnostics: Diagnostic[] = [
    ...health.errors.map((message) => toLegacyDiagnostic('error', message)),
    ...health.warnings.map((message) => toLegacyDiagnostic('warning', message)),
  ]
  if (diagnostics.length > 0 || health.status === 'ok') return diagnostics
  // An unhealthy Team always says something, so a status with no collected
  // diagnostic still reads as needing attention rather than as blank.
  return [toLegacyDiagnostic('error', 'Team configuration needs attention')]
}

function toLegacyDiagnostic(
  severity: DiagnosticSeverity,
  message: string,
): Diagnostic {
  return { severity, kind: 'unknown', message, subject: {} }
}
