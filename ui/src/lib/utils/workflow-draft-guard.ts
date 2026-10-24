export const WORKFLOW_DRAFT_DISCARD_MESSAGE =
  "Discard unsaved workflow YAML changes?";

export function confirmWorkflowDraftDiscard(isDirty: boolean): boolean {
  return !isDirty || window.confirm(WORKFLOW_DRAFT_DISCARD_MESSAGE);
}
