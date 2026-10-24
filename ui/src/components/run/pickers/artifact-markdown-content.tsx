import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { MarkdownViewer } from "@/components/markdown-viewer";
import type { ArtifactPreviewTarget } from "@/components/run/stage-renderers";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchArtifact } from "@/lib/clients/runtime-client";

export interface ArtifactMarkdownContentProps {
  artifactPath: string;
  className?: string | undefined;
  onOpenArtifact?: ((target: ArtifactPreviewTarget) => void) | undefined;
  runId: string;
}

type FetchState =
  | { status: "loading" }
  | { status: "success"; content: string }
  | { status: "error"; message: string };

/** Fetches and renders one Markdown artifact with retryable loading states. */
export function ArtifactMarkdownContent({
  artifactPath,
  className,
  onOpenArtifact,
  runId,
}: ArtifactMarkdownContentProps) {
  return (
    <ArtifactMarkdownRequest
      key={`${runId}\u0000${artifactPath}`}
      artifactPath={artifactPath}
      className={className}
      onOpenArtifact={onOpenArtifact}
      runId={runId}
    />
  );
}

function ArtifactMarkdownRequest({
  artifactPath,
  className,
  onOpenArtifact,
  runId,
}: ArtifactMarkdownContentProps) {
  const { fetchState, retry } = useArtifactMarkdown(runId, artifactPath);

  return (
    <div className={className}>
      {fetchState.status === "loading" ? (
        <LoadingSkeleton />
      ) : fetchState.status === "error" ? (
        <ArtifactError message={fetchState.message} onRetry={retry} />
      ) : (
        <MarkdownViewer
          artifactRunId={runId}
          content={fetchState.content}
          currentArtifactPath={artifactPath}
          onOpenArtifact={onOpenArtifact}
        />
      )}
    </div>
  );
}

function useArtifactMarkdown(runId: string, artifactPath: string) {
  const [reloadKey, setReloadKey] = useState(0);
  const [fetchState, setFetchState] = useState<FetchState>(() =>
    artifactPath
      ? { status: "loading" }
      : { status: "error", message: "No artifact was produced by this task." },
  );
  const retry = useCallback(() => {
    setFetchState({ status: "loading" });
    setReloadKey((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!artifactPath) return;
    let cancelled = false;
    void fetchArtifact(runId, artifactPath)
      .then((content) => {
        if (!cancelled) setFetchState({ status: "success", content });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFetchState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifactPath, reloadKey, runId]);

  return { fetchState, retry };
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-2/3 rounded-lg" />
      <Skeleton className="h-4 w-full rounded-lg" />
      <Skeleton className="h-4 w-5/6 rounded-lg" />
      <Skeleton className="h-4 w-4/6 rounded-lg" />
      <Skeleton className="h-4 w-full rounded-lg" />
      <Skeleton className="h-4 w-3/4 rounded-lg" />
      <Skeleton className="h-4 w-5/6 rounded-lg" />
    </div>
  );
}

function ArtifactError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="rounded-2xl border border-destructive/30 bg-destructive/8 px-4 py-4"
      role="alert"
    >
      <div className="text-sm font-medium text-destructive">
        Failed to load artifact
      </div>
      <div className="mt-1 break-words text-xs text-muted-foreground">
        {message}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="mt-3 gap-1.5"
        onClick={onRetry}
      >
        <RefreshCw className="size-3.5" />
        Retry
      </Button>
    </div>
  );
}
