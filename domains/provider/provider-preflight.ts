import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LevelConfig, LoadedAgent } from '../../core/types.js'
import { getCoordinatorName } from '../../core/stage-helpers.js'
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../core/constants.js'
import { getConfiguredProviderConnection } from '../../providers/configured-provider.js'
import { buildCliPath } from '../../core/cli-path.js'
import { isConfiguredProviderName } from './provider-settings.js'
import { unusableProviderOptions } from '../../contracts/agent-model-selection.js'
import { runtimeAppDefaultPair } from './default-model-selection.js'
import { PI_CLI_PATH_ENV } from '../../core/pi-runtime.js'
import { validateCodexSubscriptionAuth } from '../../core/codex-subscription-auth.js'

export const KNOWN_AGENT_PROVIDER_NAMES = [
  'anthropic',
  'openai',
  'xai',
  'deepseek',
  'kimi',
  'openrouter',
  'codex',
  'claude',
  'gemini',
  'kimi-cli',
  'qwen',
  'pi',
  'lm-studio',
] as const

const KNOWN_AGENT_PROVIDERS = new Set<string>(KNOWN_AGENT_PROVIDER_NAMES)

export const HOST_ANTHROPIC_PROVIDER = 'anthropic-api'
export const HOST_OPENAI_PROVIDER = 'openai-responses-api'
export const HOST_CODEX_PROVIDER = 'openai-codex'

export function normalizeRepoHostProvider(provider: string | undefined): string | undefined {
  if (!provider) return undefined
  if (provider === 'anthropic') return HOST_ANTHROPIC_PROVIDER
  if (provider === 'openai') return HOST_OPENAI_PROVIDER
  if (provider === 'codex') return HOST_CODEX_PROVIDER
  return provider
}

/**
 * Providers whose adapter refuses an unusable selection before it sends
 * anything, in the two facts an offer is built from.
 *
 * Membership is a property of the adapter, not of the provider's shape. To be
 * in this set an adapter must throw a `ProviderError` carrying both a typed
 * `kind` that `MODEL_SPECIFIC_FAILURES` names -- `authentication` for a
 * credential that is absent, `configuration` for a CLI that is not installed --
 * and `dispatched: false`. `contracts/model-choice.ts` reads exactly those two
 * and nothing else: an untyped failure is `provider_failed`, which is not
 * model-specific, and a missing `dispatched` reads as `unknown`, which is
 * unsafe to repeat. Either one missing means no offer can ever exist.
 *
 * Each member, and where it refuses:
 *  - `anthropic`, `openai`, `openrouter` and every `connection:<uuid>` read
 *    their credential while resolving, before the request is built.
 *  - `xai`, `deepseek` and `kimi` read theirs as the first statement of
 *    `execute()` -- `providers/xai.ts`, `providers/deepseek.ts`,
 *    `providers/kimi.ts`.
 *  - `codex`, `claude`, `gemini`, `kimi-cli` and `qwen` fail at the spawn
 *    itself: ENOENT means the process never existed, so nothing was sent.
 *    `providers/codex.ts`, `providers/gemini.ts` and the shared runner in
 *    `providers/text-cli.ts` say so.
 *
 * `codex`, `claude` and `kimi-cli` need one thing more, because they are in
 * `CLI_HOST_TOOL_BRIDGE_PROVIDERS`: a tool-enabled Agent on one of them runs
 * its turn in the parent, not in its own adapter, and the refusal comes back
 * over the worker bridge. `domains/mcp/mcp-worker-turn-client.ts` carries
 * `dispatched` across that boundary so those Agents -- which is where most of
 * the bundled pins live -- get the same offer as the rest.
 *
 * Deliberately absent:
 *  - `pi`. `providers/pi.ts` rejects with a plain `Error`, so its refusal is
 *    recorded as `dispatch_failed` with no kind and no dispatch claim. It
 *    cannot produce an offer, so an Agent pinned to a missing Pi CLI keeps its
 *    actionable startup error instead of a run that fails later and explains
 *    nothing. Fixing the adapter is what would move it, not this list.
 *  - `lm-studio`, which has no readiness failure to defer in the first place.
 *
 * Two consequences worth stating rather than discovering:
 *  - A tool-enabled Agent on a native-tool-loop provider -- `openai`,
 *    `openrouter`, `xai`, `deepseek`, `kimi`, `connection:<uuid>` -- does not
 *    run its adapter either, and the tool loop sends its request with whatever
 *    credential it found. That refusal is a real HTTP rejection, so it is
 *    honestly `unknown` and earns no offer. Pre-existing for the providers
 *    already here, and the new ones are no worse off than they are.
 *  - A deferred Agent in a stage whose `on_agent_failure` is `skip` produces
 *    neither a startup error nor an offer: the stage swallows the dispatch
 *    failure and the Agent simply never contributes. That is the stage policy
 *    doing what it was asked to do, and it is the price of not stopping the
 *    Agents that can run.
 */
const PROVIDERS_REFUSING_BEFORE_DISPATCH = new Set([
  'anthropic',
  'openai',
  'openrouter',
  'xai',
  'deepseek',
  'kimi',
  'codex',
  'claude',
  'gemini',
  'kimi-cli',
  'qwen',
])

function refusesBeforeDispatch(provider: string): boolean {
  return (
    PROVIDERS_REFUSING_BEFORE_DISPATCH.has(provider) ||
    isConfiguredProviderName(provider)
  )
}

/**
 * Whether there is a different pair the user could actually be offered.
 *
 * A default that is unset or unavailable is no offer at all, and a default
 * identical to the pair that just failed offers a retry of what did not work.
 */
function hasDistinctAvailableDefault(agent: LoadedAgent): boolean {
  const appDefault = runtimeAppDefaultPair()
  if (!appDefault) return false
  return (
    appDefault.provider !== agent.provider || appDefault.model !== agent.model
  )
}

/**
 * Every coordinator a Team declares must be an Agent that actually loaded.
 *
 * A roster name whose persona file is missing is dropped in silence at load,
 * and `validateLoadedAgentProviders` below only inspects Agents that survived
 * that drop — so an unloadable coordinator reaches the host as an absence, and
 * the host runs on whatever the application default or the boot model happens
 * to be.
 * That is a model nobody chose, for a level whose declared owner does not
 * exist.
 *
 * Checked across *every* level, not only the one the run starts on: the
 * declaration is already invalid when the config is read, and a run that
 * discovers it three levels in has by then spent turns on the wrong host.
 *
 * Pure by construction: the caller supplies what loaded and where each persona
 * was meant to be, so this decides nothing about the filesystem and can be
 * exercised without one.
 */
export function validateDeclaredCoordinators(params: {
  readonly levels: readonly LevelConfig[]
  readonly loadedAgentNames: ReadonlySet<string>
  readonly personaPathFor?: (agentName: string) => string | undefined
}): string[] {
  const errors: string[] = []
  const reported = new Set<string>()

  for (const level of params.levels) {
    const coordinator = getCoordinatorName(level)
    if (!coordinator || params.loadedAgentNames.has(coordinator)) continue
    // One message per coordinator, however many levels declare it: a reader
    // needs the name once, not once per mention.
    if (reported.has(coordinator)) continue
    reported.add(coordinator)
    const personaPath = params.personaPathFor?.(coordinator)
    errors.push(
      `Team cannot start: level '${level.id}' declares coordinator ` +
      `'${coordinator}', which is not a loaded Agent.` +
      (personaPath
        ? ` Its persona file is missing or unreadable: ${personaPath}.`
        : ' No roster entry names a persona file for it.'),
    )
  }

  return errors
}

export function validateLoadedAgentProviders(agents: Iterable<LoadedAgent>): string[] {
  const errors: string[] = []

  for (const agent of agents) {
    // Options the loader refused are an execution-boundary problem, not a note.
    // It drops them and says why, but nothing acted on that: the Agent ran with
    // its settings silently missing, and a person who wrote one could not tell
    // that from a setting the provider simply does not honour. A credential in
    // an Agent file is worse than ignored — it is in the wrong place and nobody
    // was told.
    const refusedOptions = unusableProviderOptions(agent.selectionDiagnostics)
    if (refusedOptions) {
      errors.push(
        `Team cannot start: agent '${agent.name}' has unusable provider options. ` +
        refusedOptions.message,
      )
      continue
    }
    // The loader already decided, and said why when it could not. Re-deriving
    // a complaint from the empty provider it left behind would replace an
    // actionable reason — the application default is unset, this agent names a
    // model with no provider — with "unknown provider ''", which tells an
    // operator nothing about what to change.
    if (agent.selection === null && agent.selectionError) {
      errors.push(
        `Team cannot start: agent '${agent.name}' has no model selected. ` +
        agent.selectionError.message,
      )
      continue
    }

    const provider = agent.provider
    if (!KNOWN_AGENT_PROVIDERS.has(provider) && !isConfiguredProviderName(provider)) {
      errors.push(
        `Agent '${agent.name}' references unknown provider '${provider}'. ` +
        `Known providers: ${[...KNOWN_AGENT_PROVIDERS].join(', ')}`,
      )
      continue
    }

    const readinessError = getAgentProviderReadinessError(provider)
    if (readinessError) {
      // Deferred only when the deferral can actually become a choice, which
      // takes all three of these at once. Failing the whole Team at startup
      // means this Agent never dispatches, so the adapter never refuses, no
      // failure evidence is recorded, and no offer can ever be made — but
      // deferring a failure that cannot produce an offer is worse still: it
      // trades an actionable startup error for a run that fails later and
      // explains nothing.
      //
      // Deliberately not deferred: an unknown provider, a selection the loader
      // could not resolve, an Agent already inheriting the application default,
      // a provider whose adapter cannot report that nothing was sent (`pi`),
      // and a default that is missing or identical to the pair that just
      // failed.
      if (
        agent.selection?.source === 'agent' &&
        refusesBeforeDispatch(provider) &&
        hasDistinctAvailableDefault(agent)
      ) {
        continue
      }

      errors.push(
        isUnresolvedSentinel(agent) && !runtimeAppDefaultPair()
          ? `Agent '${agent.name}' has no model configured and no AI provider is available. ` +
            `Add a connection in Settings → AI Providers or install a supported CLI ` +
            `(codex, claude, gemini, kimi, qwen, pi).`
          // Name the consequence, not just the condition. One unready roster
          // member stops the whole Team from starting — `initialize()` refuses
          // on any provider error, whatever the stage's `on_agent_failure`
          // policy says — so a reader who only sees "this agent cannot use its
          // provider" would reasonably expect the Team to run without it.
          : `Team cannot start: agent '${agent.name}' cannot use provider ` +
            `'${provider}': ${readinessError}`,
      )
    }
  }

  return [...new Set(errors)]
}

function isUnresolvedSentinel(agent: LoadedAgent): boolean {
  return agent.provider === DEFAULT_PROVIDER && agent.model === DEFAULT_MODEL
}

export function validateHostProviderReadiness(provider: string | undefined, model: string | undefined): string[] {
  if (!provider || !model) return []

  const normalized = normalizeRepoHostProvider(provider)
  switch (normalized) {
    case HOST_ANTHROPIC_PROVIDER:
      return process.env.ANTHROPIC_API_KEY
        ? []
        : [`Host provider '${provider}' requires ANTHROPIC_API_KEY (or CLAUDE_API_KEY in .env).`]
    case HOST_OPENAI_PROVIDER:
      return process.env.OPENAI_API_KEY
        ? []
        : [`Host provider '${provider}' requires OPENAI_API_KEY.`]
    case HOST_CODEX_PROVIDER: {
      if (!commandExists('codex')) {
        return ["Host provider 'codex' requires the Codex CLI on PATH."]
      }
      const authError = validateCodexSubscriptionAuth()
      return authError ? [`Host provider 'codex' is unavailable: ${authError}`] : []
    }
    case 'lm-studio':
    case 'anthropic':
    case 'openai':
      return []
    default:
      return [
        `Host provider '${provider}' is not supported by the repo-local host bridge. ` +
        `Supported host providers from this codebase: anthropic, openai, codex. ` +
        `Use '${provider}' only for agent providers unless Pi already exposes it as a built-in host model.`,
      ]
  }
}

export function openAiHostSupportsReasoningEffort(modelId: string): boolean {
  return /^(gpt-5|o1|o3|o4)/.test(modelId)
}

function getAgentProviderReadinessError(provider: string): string | undefined {
  if (isConfiguredProviderName(provider)) {
    return getConfiguredProviderConnection(provider)
      ? undefined
      : `configured provider '${provider}' is unavailable`
  }
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY
        ? undefined
        : 'missing ANTHROPIC_API_KEY (CLAUDE_API_KEY is accepted via .env aliasing)'
    case 'openai':
      return process.env.OPENAI_API_KEY ? undefined : 'missing OPENAI_API_KEY'
    case 'xai':
      return process.env.XAI_API_KEY ? undefined : 'missing XAI_API_KEY'
    case 'deepseek':
      return process.env.DEEPSEEK_API_KEY ? undefined : 'missing DEEPSEEK_API_KEY'
    case 'kimi':
      return process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY
        ? undefined
        : 'missing MOONSHOT_API_KEY or KIMI_API_KEY'
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY ? undefined : 'missing OPENROUTER_API_KEY'
    case 'codex':
      return commandExists('codex') ? undefined : "missing 'codex' on PATH"
    case 'claude':
      return commandExists('claude') ? undefined : "missing 'claude' on PATH"
    case 'gemini':
      return commandExists('gemini') ? undefined : "missing 'gemini' on PATH"
    case 'kimi-cli':
      return commandExists('kimi') ? undefined : "missing 'kimi' on PATH"
    case 'qwen':
      return commandExists('qwen') ? undefined : "missing 'qwen' on PATH"
    case 'pi':
      return hasBundledPiCli() || commandExists('pi')
        ? undefined
        : "missing bundled Pi CLI and 'pi' on PATH"
    case 'lm-studio':
      return undefined
    default:
      return `unknown provider '${provider}'`
  }
}

function commandExists(command: string): boolean {
  const pathEnv = buildCliPath(process.env.PATH)

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return true
    } catch {
      // Keep scanning PATH entries.
    }
  }

  return false
}

function hasBundledPiCli(): boolean {
  const bundledCliPath = process.env[PI_CLI_PATH_ENV]?.trim()
  if (!bundledCliPath) return false
  try {
    return fs.statSync(bundledCliPath).isFile()
  } catch {
    return false
  }
}
