export function WorkspaceLoading({ label }: { label: string }) {
  return (
    <div
      aria-live="polite"
      className="flex h-full min-h-0 items-center justify-center bg-background text-sm text-muted-foreground"
      role="status"
    >
      Loading {label} workspace…
    </div>
  );
}
