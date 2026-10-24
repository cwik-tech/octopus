/**
 * Provider Barrel — Registration + Public API
 *
 * Call initProviders() once at extension boot to register all providers.
 * After that, getProvider(name) is available everywhere.
 *
 * Adding a new provider: create providers/<name>.ts, add one import +
 * one registerProvider() call below, and team.yaml authors can use it.
 */

import { registerProvider, getProvider } from './registry.js'
import type { Provider } from './types.js'
import { createAnthropicProvider } from './anthropic.js'
import { createPiProvider } from './pi.js'
import { createCodexProvider } from './codex.js' /* T5 */
import { createGeminiProvider } from './gemini.js' /* T6 */
import { createLmStudioProvider } from './lm-studio.js'
import { createOpenAIProvider } from './openai.js'
import { createOpenRouterProvider } from './openrouter.js'
import { createXAIProvider } from './xai.js'
import { createDeepSeekProvider } from './deepseek.js'
import { createKimiProvider } from './kimi.js'
import { createClaudeProvider } from './claude.js'
import { createKimiCliProvider } from './kimi-cli.js'
import { createQwenProvider } from './qwen.js'

export {
  getProvider,
  getProviderProvenance,
  registerProvider,
} from './registry.js'
export type { ProviderProvenance } from './registry.js'
export { executeProvider } from './protocol.js'
export type { Provider, ProviderExecuteOptions, ProviderResult } from './types.js'

let builtinsInitialized = false

/**
 * Register all built-in providers. Call once at extension boot before
 * any agent dispatch can happen.
 */
export function initProviders(): void {
  if (builtinsInitialized) return
  registerBuiltinProvider(createAnthropicProvider())
  registerBuiltinProvider(createPiProvider())
  registerBuiltinProvider(createCodexProvider()) /* T5 */
  registerBuiltinProvider(createGeminiProvider()) /* T6 */
  registerBuiltinProvider(createLmStudioProvider())
  registerBuiltinProvider(createOpenAIProvider())
  registerBuiltinProvider(createOpenRouterProvider())
  registerBuiltinProvider(createXAIProvider())
  registerBuiltinProvider(createDeepSeekProvider())
  registerBuiltinProvider(createKimiProvider())
  registerBuiltinProvider(createClaudeProvider())
  registerBuiltinProvider(createKimiCliProvider())
  registerBuiltinProvider(createQwenProvider())
  builtinsInitialized = true
}

function registerBuiltinProvider(provider: Provider): void {
  registerProvider(provider, {
    source: `providers/${provider.name}.ts`,
    trustClass: 'builtin',
  })
}
