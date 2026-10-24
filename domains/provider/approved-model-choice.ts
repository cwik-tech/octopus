/**
 * Runtime transport for one user-approved model retry.
 *
 * The approval is made in the API process; the agent it covers runs in a child.
 * What travels is an *authorization*, not a configuration: it names one offer,
 * one agent and the exact pair the user was shown, and nothing merges it into a
 * team config or a roster entry. That distinction is the whole point — a
 * per-agent pair carried as configuration would rebuild the member-level
 * override this work removes, under a new name.
 *
 * Shaped like `default-model-selection.ts` deliberately: published in-process,
 * carried to children in `PIPELINE_APPROVED_MODEL_CHOICE` as base64 JSON, and
 * hydrated lazily on first read. Anything unreadable is read as *no*
 * authorization, which leaves the agent running on its own failing pair — the
 * same outcome as before the approval, and the safe direction.
 */

import {
  readApprovedModelChoiceAuthorization,
  type ApprovedModelChoiceAuthorization,
} from "../../contracts/model-choice.js";

export const APPROVED_MODEL_CHOICE_ENV = "PIPELINE_APPROVED_MODEL_CHOICE";

let runtimeAuthorization: ApprovedModelChoiceAuthorization | undefined;
let hydrated = false;

/**
 * Publishes the authorization in-process and to child processes.
 *
 * Pass `undefined` to forget the in-process value and re-hydrate from the
 * environment on the next read (primarily for tests).
 */
export function setRuntimeApprovedModelChoice(
  authorization: ApprovedModelChoiceAuthorization | undefined,
): void {
  runtimeAuthorization = authorization;
  if (authorization === undefined) {
    hydrated = false;
    return;
  }
  hydrated = true;
  process.env[APPROVED_MODEL_CHOICE_ENV] = encode(authorization);
}

/**
 * Takes the authorization away, in this process and for any child.
 *
 * Distinct from `setRuntimeApprovedModelChoice(undefined)`, which only drops
 * the cached value and re-reads the environment. An authorization covers one
 * dispatch; leaving the environment variable behind would let the next child
 * process read consent the user gave for a different step.
 */
export function clearRuntimeApprovedModelChoice(): void {
  runtimeAuthorization = undefined;
  hydrated = true;
  delete process.env[APPROVED_MODEL_CHOICE_ENV];
}

export function getRuntimeApprovedModelChoice():
  | ApprovedModelChoiceAuthorization
  | undefined {
  if (hydrated) return runtimeAuthorization;
  runtimeAuthorization = readFromEnvironment(process.env);
  hydrated = true;
  return runtimeAuthorization;
}

/** The environment a child process needs to honour this authorization. */
export function approvedModelChoiceEnvironment(
  authorization: ApprovedModelChoiceAuthorization | undefined,
): Record<string, string> {
  return authorization === undefined
    ? {}
    : { [APPROVED_MODEL_CHOICE_ENV]: encode(authorization) };
}

function encode(authorization: ApprovedModelChoiceAuthorization): string {
  return Buffer.from(JSON.stringify(authorization), "utf8").toString("base64");
}

function readFromEnvironment(
  env: NodeJS.ProcessEnv,
): ApprovedModelChoiceAuthorization | undefined {
  const encoded = env[APPROVED_MODEL_CHOICE_ENV];
  if (!encoded) return undefined;
  try {
    return readApprovedModelChoiceAuthorization(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}
