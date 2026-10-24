import type { SessionStore } from '../domains/sessions/session-store.js';
import { providerAbortReason } from '../contracts/provider-abort.js';

// Scoped to one server's store. Journals own outcomes; this owns live cancellation.
const turnsByStore = new WeakMap<SessionStore, Map<string, AbortController>>();

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

export function registerActiveAgentTurn(store: SessionStore, sessionId: string, turnId: string, parentSignal?: AbortSignal) {
  const turns = turnsByStore.get(store) ?? new Map<string, AbortController>();
  turnsByStore.set(store, turns);
  const key = turnKey(sessionId, turnId);
  const controller = new AbortController();
  if (turns.has(key)) throw new Error('Agent turn already registered');
  turns.set(key, controller);
  return {
    signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal,
    release: () => { if (turns.get(key) === controller) turns.delete(key); },
  };
}

export function cancelActiveAgentTurn(store: SessionStore, sessionId: string, turnId: string): boolean {
  const controller = turnsByStore.get(store)?.get(turnKey(sessionId, turnId));
  if (!controller) return false;
  controller.abort(providerAbortReason('user-stop'));
  return true;
}
