/**
 * Runtime transport for the one application-wide default model.
 *
 * Settings → AI Providers owns the choice. The API server process publishes it
 * in-process via `setRuntimeDefaultModelState` (called from
 * `ProviderSettingsService.hydrateRuntime` and fresh snapshots). Spawned runtimes
 * receive the same value through the `PIPELINE_DEFAULT_MODEL_SELECTION` environment
 * variable (base64-encoded JSON), hydrated lazily on first read.
 *
 * What travels is the default's *state*, not a bare pair. A configured default
 * that cannot currently run stays identifiable, so a child process can report
 * which selection is broken instead of inventing a replacement. There is no
 * second default store and no catalog-order fallback anywhere on this path.
 */

import type {
  AppDefaultModelState,
  ProviderModelPair,
} from "../../contracts/agent-model-selection.js";
import { DEFAULT_MODEL_SELECTION_ENV } from "./provider-settings.js";

const UNSET: AppDefaultModelState = { status: "unset" };

let runtimeState: AppDefaultModelState | undefined;

/**
 * Publishes the state in-process and to child processes.
 *
 * Pass `undefined` to forget only the in-process value and re-hydrate from the
 * environment on the next read (primarily for tests).
 */
export function setRuntimeDefaultModelState(
  state: AppDefaultModelState | undefined,
): void {
  runtimeState = state;
  if (state === undefined) return;
  if (state.status === "unset") {
    delete process.env[DEFAULT_MODEL_SELECTION_ENV];
  } else {
    process.env[DEFAULT_MODEL_SELECTION_ENV] = encodeState(state);
  }
}

export function getRuntimeDefaultModelState(): AppDefaultModelState {
  if (runtimeState !== undefined) return runtimeState;
  runtimeState = readStateFromEnvironment(process.env);
  return runtimeState;
}

/**
 * The default's pair when it is usable, otherwise `null`.
 *
 * Callers that need to explain an unset or unavailable default read the state
 * directly; this is for the ones that only need a runnable pair.
 */
export function runtimeAppDefaultPair(): ProviderModelPair | null {
  const state = getRuntimeDefaultModelState();
  return state.status === "available"
    ? { provider: state.provider, model: state.model }
    : null;
}

export function defaultModelStateEnvironment(
  state: AppDefaultModelState,
): Record<string, string> {
  return state.status === "unset"
    ? {}
    : { [DEFAULT_MODEL_SELECTION_ENV]: encodeState(state) };
}

function encodeState(state: AppDefaultModelState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

/**
 * Decodes an untrusted environment payload.
 *
 * Anything that is not a well-formed state — including the legacy bare
 * `{provider, model}` payload, which is accepted as an available default — is
 * reported as unset rather than partially trusted.
 */
function readStateFromEnvironment(
  env: NodeJS.ProcessEnv,
): AppDefaultModelState {
  const encoded = env[DEFAULT_MODEL_SELECTION_ENV];
  if (!encoded) return UNSET;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return UNSET;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return UNSET;
  }
  const record = parsed as Record<string, unknown>;
  const provider = stringField(record.provider);
  const model = stringField(record.model);
  if (!provider || !model) return UNSET;
  const status = record.status;
  if (status === "unavailable") {
    const detail = stringField(record.detail);
    return {
      status: "unavailable",
      provider,
      model,
      ...(detail ? { detail } : {}),
    };
  }
  if (status === undefined || status === "available") {
    const capabilities = stringArrayField(record.capabilities);
    return {
      status: "available",
      provider,
      model,
      ...(capabilities ? { capabilities } : {}),
    };
  }
  return UNSET;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayField(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return entries.length === value.length ? entries : undefined;
}
