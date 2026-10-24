import type {
  Provider,
  ProviderExecuteOptions,
  ProviderProtocolEvent,
  ProviderResult,
} from './types.js'

export async function collectProtocolEvents(
  events: AsyncIterable<ProviderProtocolEvent>,
  fallbackModel: string,
  onEvent?: (event: ProviderProtocolEvent) => void,
): Promise<ProviderResult> {
  const startedAt = Date.now()
  const textParts: string[] = []
  let cost = 0
  let costTracked = false
  let inputTokens = 0
  let outputTokens = 0
  let contextTokens = 0
  let model = fallbackModel
  let durationMs = 0

  for await (const event of events) {
    onEvent?.(event)
    if (event.model) model = event.model
    if (typeof event.cost === 'number') {
      cost = event.cost
      costTracked = true
    }
    if (typeof event.inputTokens === 'number') inputTokens = event.inputTokens
    if (typeof event.outputTokens === 'number') outputTokens = event.outputTokens
    if (typeof event.contextTokens === 'number') contextTokens = event.contextTokens
    if (typeof event.durationMs === 'number') durationMs = event.durationMs
    if (event.kind === 'text' && event.text) textParts.push(event.text)
  }

  return {
    text: textParts.join(''),
    cost,
    durationMs: durationMs || Date.now() - startedAt,
    inputTokens,
    outputTokens,
    contextTokens,
    model,
    costTracked,
    costSource: costTracked ? 'reported' : 'untracked',
  }
}

export async function executeProvider(
  provider: Provider,
  options: ProviderExecuteOptions,
  onEvent?: (event: ProviderProtocolEvent) => void,
): Promise<ProviderResult> {
  if (!provider.stream) {
    // An execute()-only provider can still emit mid-turn through
    // `onProtocolEvent` — lm-studio and codex both do. Returning
    // `provider.execute(options)` directly here used to drop `onEvent` on the
    // floor, which is why nothing downstream ever saw incremental text.
    if (!onEvent) return provider.execute(options)
    const existing = options.onProtocolEvent
    return provider.execute({
      ...options,
      onProtocolEvent: (event) => {
        existing?.(event)
        onEvent(event)
      },
    })
  }
  return collectProtocolEvents(provider.stream(options), options.model, onEvent)
}
