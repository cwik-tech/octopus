import { runtimeAppDefaultPair } from './default-model-selection.js'
import { whenDefined } from '../../core/optional-properties.js'
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'
import type { LoadedAgent, TeamRegistryEntry } from '../../core/types.js'
import { normalizeRepoHostProvider } from './provider-preflight.js'

export interface HostModelSpec {
  model: string
  provider?: string
  source: 'registry' | 'coordinator' | 'app-default'
}

export interface HostModelCandidate {
  id: string
  provider: string
}


export function getAvailableHostModels<T extends HostModelCandidate>(modelRegistry: {
  getAvailable?: () => T[]
  getAll?: () => T[]
}): T[] {
  try {
    if (typeof modelRegistry.getAvailable === 'function') {
      return modelRegistry.getAvailable()
    }
  } catch {
    // Fall through to getAll()
  }

  try {
    if (typeof modelRegistry.getAll === 'function') {
      return modelRegistry.getAll()
    }
  } catch {
    // Ignore and return empty
  }

  return []
}

/**
 * Which model the host process should run on.
 *
 * The two-choice rule reaches the host: the coordinator Agent runs with its own
 * pair, or with the one application default. A registry `host_model` is a
 * Team-level model setting and is no longer a source — with it winning, the
 * host ran on a pair that disagreed with both the Agent's choice and with the
 * provenance recorded for that coordinator, and nothing on screen could
 * explain the difference.
 *
 * `bootEntry` is still accepted so callers need not change and so a retired
 * host pin can be diagnosed here later, but it no longer decides anything.
 */
export function resolveDesiredHostModel(
  _bootEntry: TeamRegistryEntry | null,
  coordinator: LoadedAgent | undefined,
): HostModelSpec | null {
  // Inheriting is not choosing. Only a pair the Agent itself names is its own
  // choice; a coordinator whose pair came from the default has made none, and
  // the raw model field cannot tell the two apart.
  if (coordinator?.selection?.source === 'agent') {
    return {
      model: coordinator.selection.model,
      provider: coordinator.selection.provider,
      source: 'coordinator',
    }
  }

  // The two-choice rule reaches the host process. A coordinator that names no
  // model has made no choice, and the one pair anybody deliberately selected is
  // the application default. Returning nothing would leave the host on whatever
  // it booted with — a model nobody chose, which no record can explain.
  const appDefault = runtimeAppDefaultPair()
  if (appDefault) {
    return {
      model: appDefault.model,
      provider: appDefault.provider,
      source: 'app-default',
    }
  }

  return null
}

/**
 * How the host's own model was decided, in the shape every other model use is
 * recorded in.
 *
 * The host process is a model use like any other, and a run has to be able to
 * say whether it ran on the application default. The lifecycle events carried
 * the pair alone, which cannot answer that. A spec with no provider names half
 * a pair, and half a pair is not a record.
 */
export function hostModelSelectionRecord(
  spec: HostModelSpec,
): ModelSelectionRecord | undefined {
  if (!spec.provider || !spec.model) return undefined
  return {
    provider: spec.provider,
    model: spec.model,
    source: spec.source === 'coordinator' ? 'agent' : 'app-default',
    reason:
      spec.source === 'coordinator' ? 'explicit-agent-choice' : 'agent-default',
    caller: 'agent',
  }
}

export function normalizeHostProvider(provider: string | undefined): string | undefined {
  return normalizeRepoHostProvider(provider)
}

export function selectHostModel<T extends HostModelCandidate>(
  models: T[],
  spec: HostModelSpec,
): T | undefined {
  const normalizedProvider = normalizeHostProvider(spec.provider)
  if (normalizedProvider) {
    return models.find((model) => model.provider === normalizedProvider && model.id === spec.model)
  }

  return models.find((model) => model.id === spec.model)
}

