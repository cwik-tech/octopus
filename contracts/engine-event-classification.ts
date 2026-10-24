import type { EngineEventCategory } from './runtime-events.js'

/**
 * Legacy engine-log classification (Phase 8 ADR §11).
 *
 * Before any engine-event writer moves onto the canonical journal, every
 * family must be classified, because the three classes take different routes:
 *
 * - `execution-fact` — replace the direct legacy write with one canonical
 *   append and derive the legacy-format projection from it.
 * - `diagnostic` — keep it outside the journal and drop any implication that
 *   it is authoritative.
 * - `content` — retain the payload in its owned file and append only the
 *   validated identity/receipt needed for execution and audit. Raw prose,
 *   prompts, and model output never enter the canonical journal.
 *
 * An unrecognized family is `unclassified` and is **not** migratable. Guessing
 * would either drop an execution fact or leak raw content into the journal, so
 * a new family must be classified here before its writer can move.
 */

export type EngineEventClass =
  | 'execution-fact'
  | 'diagnostic'
  | 'content'
  | 'unclassified'

export interface EngineEventClassification {
  readonly kind: EngineEventClass
  /** Whether this family may be moved onto the canonical journal. */
  readonly migratable: boolean
  readonly reason: string
  /**
   * What the category suggests this family probably is. Documentation for
   * whoever classifies it next; never a substitute for an explicit entry.
   */
  readonly categoryIntent: EngineEventClass
}

/**
 * Category intent. This is documentation, not classification: it says what a
 * family in this category is *likely* to be, to guide whoever adds the
 * explicit type entry. Nothing migrates on the strength of its category.
 */
const CATEGORY_DEFAULTS: Readonly<Record<EngineEventCategory, EngineEventClass>> = {
  run: 'execution-fact',
  stage: 'execution-fact',
  gate: 'execution-fact',
  tool: 'execution-fact',
  delegation: 'execution-fact',
  // Progress reporting about an agent does not decide execution.
  agent: 'diagnostic',
  // Artifact events reference produced content; the content stays in its file.
  artifact: 'content',
  // Mixed by design, so every runtime family needs an explicit entry.
  runtime: 'unclassified',
}

const TYPE_OVERRIDES: Readonly<Record<string, EngineEventClass>> = {
  // Run and stage lifecycle transitions decide what executes next.
  'run.session_started': 'execution-fact',
  'gate.transition': 'execution-fact',
  // Capability dispatch facts — already canonical as `capability.dispatch.*`.
  'mcp.tool.requested': 'execution-fact',
  'mcp.tool.started': 'execution-fact',
  'mcp.tool.completed': 'execution-fact',
  'mcp.tool.failed': 'execution-fact',
  'mcp.tool.cancelled': 'execution-fact',
  // Approval and elicitation gate whether an effect may proceed.
  'mcp.approval.requested': 'execution-fact',
  'mcp.approval.resolved': 'execution-fact',
  'mcp.elicitation.requested': 'execution-fact',
  'mcp.elicitation.resolved': 'execution-fact',
  'mcp.resource.imported': 'content',
  // Raw conversation prose: retained in its own transcript file.
  'discussion.message': 'content',
  // The same, for the mode-neutral Team chat message every engine publishes.
  'team.message': 'content',
  'artifact.written': 'content',
  // Reporting only.
  'planning.status': 'diagnostic',
  'agent.progress': 'diagnostic',
}

const REASONS: Readonly<Record<EngineEventClass, string>> = {
  'execution-fact':
    'Decides or gates execution, so the journal is its authority and the legacy view is derived.',
  diagnostic:
    'Reporting only; kept outside the journal with no authoritative implication.',
  content:
    'Payload is artifact or transcript content; only a validated receipt belongs in the journal.',
  unclassified:
    'No classification recorded; migrating it would either drop an execution fact or leak raw content.',
}

export function classifyEngineEvent(event: {
  readonly category: EngineEventCategory
  readonly type: string
}): EngineEventClassification {
  // Classification is per type, never inherited from a category. A category
  // default records intent for the families listed below it, but an
  // unrecognized type must not inherit `execution-fact` and become migratable:
  // writers such as `logDelegationEvent` accept arbitrary event names, so an
  // inherited classification would journal an unreviewed payload.
  const kind = TYPE_OVERRIDES[event.type] ?? 'unclassified'
  return {
    kind,
    migratable: kind !== 'unclassified',
    reason: REASONS[kind],
    categoryIntent: CATEGORY_DEFAULTS[event.category] ?? 'unclassified',
  }
}

/** The classification table, for documentation and coverage assertions. */
export function engineEventClassificationCoverage(): {
  readonly categoryDefaults: Readonly<Record<EngineEventCategory, EngineEventClass>>
  readonly typeOverrides: Readonly<Record<string, EngineEventClass>>
} {
  return { categoryDefaults: CATEGORY_DEFAULTS, typeOverrides: TYPE_OVERRIDES }
}
