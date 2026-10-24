/**
 * Workflows are not open to users yet, so the Run and Create tab strips hide
 * them. A UI built with VITE_ENABLE_WORKFLOWS=1 shows them again; the unit
 * tests and the desktop E2E scripts build that way.
 */
export function workflowsEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_WORKFLOWS === "1";
}
