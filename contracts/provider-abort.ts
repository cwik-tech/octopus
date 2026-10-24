export const PROVIDER_ABORT_SOURCES = ['user-stop', 'request-disconnected', 'provider-deadline', 'caller-abort'] as const;
export type ProviderAbortSource = typeof PROVIDER_ABORT_SOURCES[number];

export function isProviderAbortSource(value: unknown): value is ProviderAbortSource {
  return PROVIDER_ABORT_SOURCES.some((source) => source === value);
}

export function providerAbortReason(source: ProviderAbortSource) {
  return { kind: 'provider-abort' as const, source };
}

/** AbortSignal.reason is untrusted; retain only this runtime's closed vocabulary. */
export function providerAbortSource(reason: unknown): ProviderAbortSource {
  if (typeof reason === 'object' && reason !== null && 'kind' in reason &&
      reason.kind === 'provider-abort' && 'source' in reason && isProviderAbortSource(reason.source)) {
    return reason.source;
  }
  return 'caller-abort';
}
