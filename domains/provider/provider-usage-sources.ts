import { createCodexRolloutUsageSource } from './codex-usage-source.js'
import type { ProviderUsageSource } from './provider-usage.js'

/**
 * Everyone who can currently say how much of a provider's allowance is gone.
 *
 * A plain list rather than a registry: order is by price, adding a source is
 * adding a line, and nothing depends on which module happened to be imported
 * first.
 *
 * Only Codex is here because only Codex writes the answer down. The other
 * CLIs this app can run — `claude`, `gemini`, `qwen`, `kimi-cli`, `pi` — keep
 * local activity statistics, which count what you spent rather than what the
 * provider says you have left, and inferring one from the other would be
 * inventing a number. A provider with no source is silent, exactly as it was
 * before this existed.
 *
 * The second step, when it comes, is a source that asks a provider directly.
 * It belongs in this list with `cost: 'billable'`, and every caller that must
 * not spend money already says so.
 */
export const BUILT_IN_PROVIDER_USAGE_SOURCES: readonly ProviderUsageSource[] = [
  createCodexRolloutUsageSource(),
]
