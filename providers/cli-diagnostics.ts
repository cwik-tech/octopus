import { parseProviderError } from '../domains/provider/provider-error.js';
import type { ProviderTurnDiagnosticEntry, ProviderTurnDiagnosticsRecorder } from '../domains/runtime/provider-turn-diagnostics.js';
import { CLI_DIAGNOSTIC_MAX_ATTEMPT, CLI_DIAGNOSTIC_MAX_RETRY_DELAY_MS } from '../domains/runtime/provider-turn-diagnostics.js';

type CliDiagnostic = Extract<ProviderTurnDiagnosticEntry, { kind: 'provider-cli-diagnostic' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoundedInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

/** Classify at the stream boundary; never retain the provider's free text or arbitrary codes. */
export function readCliDiagnostic(input: unknown, channel: 'stdout' | 'stderr'): CliDiagnostic | undefined {
  let value: unknown = input;
  if (typeof input === 'string') {
    if (!input.trim()) return undefined;
    try { value = JSON.parse(input); } catch { value = undefined; }
  }
  const data = isRecord(value) ? value : undefined;
  if (data?.type === 'rate_limit_event' &&
      (!isRecord(data.rate_limit_info) || data.rate_limit_info.status !== 'rejected')) return undefined;
  const structuredRetry = data?.type === 'system' && data.subtype === 'api_retry';
  if (channel === 'stdout' && !structuredRetry && data?.type !== 'error' && data?.type !== 'turn.failed' &&
      data?.type !== 'rate_limit_event' && !(data?.type === 'result' && data.is_error === true)) return undefined;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  if (typeof text !== 'string') return undefined;
  const parsed = parseProviderError(input);
  const retry = structuredRetry || /\bretry(?:ing)?\b/i.test(text);
  const attempt = readBoundedInteger(data?.attempt ?? Number(/\battempt\s+(\d+)/i.exec(text)?.[1]), CLI_DIAGNOSTIC_MAX_ATTEMPT);
  const delay = /\bretry(?:ing)?\s+in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|s)\b/i.exec(text);
  const retryDelayMs = readBoundedInteger(data?.retry_delay_ms ?? (Number(delay?.[1]) * (delay?.[2]?.toLowerCase().startsWith('m') ? 1 : 1000)), CLI_DIAGNOSTIC_MAX_RETRY_DELAY_MS);
  const statedStatus = /\b(?:API\s+Error|HTTP(?:\s+status)?|status(?:\s+code)?)[\s:=]+([1-5]\d{2})\b/i.exec(text)?.[1];
  const status = readBoundedInteger(data?.error_status ?? parsed.statusCode ?? Number(statedStatus), 599);
  const failureKind = parsed.kind === 'unknown' && status !== undefined ? parseProviderError({ statusCode: status }).kind : parsed.kind;
  return { kind: 'provider-cli-diagnostic', channel,
    category: retry ? 'retry' : data?.type === 'rate_limit_event' ? 'rate_limit' : failureKind,
    ...(status === undefined || status < 100 || status > 599 ? {} : { statusCode: status }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
  };
}

/** Bound incomplete stderr lines; the durable recorder separately caps stream event counts. */
export function createStderrDiagnosticObserver(recorder: ProviderTurnDiagnosticsRecorder | undefined) {
  let pending = '';
  const emit = (line: string): void => {
    const entry = readCliDiagnostic(line, 'stderr');
    if (entry) recorder?.record(entry);
  };
  return {
    write(text: string): void {
      if (!recorder) return;
      const lines = (pending + text).split('\n');
      pending = (lines.pop() ?? '').slice(-16_384);
      for (const line of lines) emit(line.slice(-16_384));
    },
    end(): void { if (recorder) emit(pending); pending = ''; },
  };
}
