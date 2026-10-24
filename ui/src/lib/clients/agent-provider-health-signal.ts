const listeners = new Set<() => void>();

/**
 * Watch for agent provider health going out of date.
 *
 * The answer changes without anyone asking for it again. Editing an agent's
 * provider in the Create tab changes which account it needs, and a run that
 * dies on an exhausted key changes what is true about an account nobody
 * touched. Neither changes the list of agent names, so a long-lived reader
 * keyed on those names sat on the previous answer until the user navigated
 * away and back — which is exactly how the staleness was found.
 *
 * Its own module rather than another export on the agent client: the things
 * that publish (a persona save, a refused chat turn) and the thing that listens
 * (the sidebars' shared health hook) have nothing else in common, and a dozen
 * test files mock that client one export at a time.
 */
export function subscribeToAgentProviderHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Say that anything already displayed about agent health may now be wrong. */
export function invalidateAgentProviderHealth(): void {
  for (const listener of [...listeners]) listener();
}
