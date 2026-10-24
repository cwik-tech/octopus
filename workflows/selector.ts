import type { WorkflowRegistryEntry } from './types.js'
import {
  hasClearWorkflowMatch,
  rankWorkflowMatches,
} from '../core/workflow-matcher.js'
import { whenDefined } from '../core/optional-properties.js'

/**
 * Dormant legacy deterministic workflow selector.
 *
 * This is intentionally not used by Run chat or `spawn_workflow`: semantic
 * workflow selection belongs to the LLM, while the runtime validates its exact
 * registry id. It is retained for a possible future offline fallback or as a
 * retrieval shortlisting primitive. Re-enabling it as a selection authority
 * requires an explicit architecture decision.
 */
export function selectWorkflowForBrief(
  brief: string,
  registry: Map<string, WorkflowRegistryEntry>,
): WorkflowRegistryEntry | null {
  const candidates = [...registry.values()].map((entry) => ({
    id: entry.name,
    ...whenDefined(entry.description, (description) => ({ description })),
    ...whenDefined(entry.tags, (tags) => ({ tags })),
    ...whenDefined(entry.capabilities, (capabilities) => ({ capabilities })),
  }))
  const ranked = rankWorkflowMatches(candidates, brief)
  const selectedId = hasClearWorkflowMatch(ranked) ? ranked[0]?.workflow.id : undefined
  return selectedId === undefined ? null : registry.get(selectedId) ?? null
}
