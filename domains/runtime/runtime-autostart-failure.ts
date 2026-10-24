export function shouldRecordRuntimeAutostartFailure(
  shutdownSignal: AbortSignal,
): boolean {
  return !shutdownSignal.aborted
}
