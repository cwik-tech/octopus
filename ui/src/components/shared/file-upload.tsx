import { CircleAlert, FileText, Loader2, Trash2, Upload } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  startTransition,
} from "react";

import { Button } from "@/components/ui/button";
import { PanelItem } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, parseStatusLabel, documentReviewLabel } from "@/components/shared/file-format";
import type { SessionFile } from "@/lib/models/session-model";

export interface FileUploadApi {
  list(ownerId: string): Promise<SessionFile[]>;
  upload(ownerId: string, file: File): Promise<SessionFile>;
  delete(ownerId: string, filename: string): Promise<void>;
}

interface FileUploadProps {
  ownerId: string;
  api: FileUploadApi;
  accept?: string;
  helperText?: string;
  maxFiles?: number;
  disabled?: boolean;
  refreshKey?: string | number;
  onFilesChanged?: (() => void | Promise<void>) | undefined;
  initialFiles?: SessionFile[];
}

function FileUpload({
  ownerId,
  api,
  accept,
  helperText = "PDF, DOCX, XLSX, PPTX, images, or text.",
  maxFiles,
  disabled = false,
  refreshKey,
  onFilesChanged,
  initialFiles,
}: FileUploadProps) {
  const controlled = initialFiles !== undefined;
  const [localFiles, setLocalFiles] = useState<SessionFile[]>(() => initialFiles ?? []);
  const [localLoading, setLocalLoading] = useState(initialFiles === undefined);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const files = initialFiles ?? localFiles;
  const loading = controlled ? false : localLoading;
  const fileLimitReached = maxFiles !== undefined && files.length >= maxFiles;
  const uploadDisabled = uploading || disabled || fileLimitReached;

  const load = useCallback(async () => {
    try {
      const next = await api.list(ownerId);
      startTransition(() => {
        setLocalFiles(next);
        setError(null);
      });
    } catch (err) {
      startTransition(() => {
        setError(err instanceof Error ? err.message : String(err));
      });
    } finally {
      startTransition(() => {
        setLocalLoading(false);
      });
    }
  }, [api, ownerId]);

  useEffect(() => {
    if (controlled) return;
    startTransition(() => {
      setLocalLoading(true);
      setLocalFiles([]);
    });
    void load();
  }, [controlled, load, refreshKey]);

  useEffect(() => {
    startTransition(() => {
      setError(null);
      setUploading(false);
      setDragOver(false);
    });
  }, [ownerId]);

  const handleFiles = useCallback(
    async (incoming: FileList | File[]) => {
      if (uploadDisabled) return;
      const list = Array.from(incoming);
      if (list.length === 0) return;

      const availableSlots = maxFiles === undefined
        ? list.length
        : Math.max(0, maxFiles - files.length);
      const selectedFiles = list.slice(0, availableSlots);
      if (selectedFiles.length === 0) return;

      setUploading(true);
      setError(null);
      let uploadError: string | null =
        selectedFiles.length < list.length
          ? `Only ${availableSlots} additional document${availableSlots === 1 ? "" : "s"} can be uploaded.`
          : null;
      let filesChanged = false;
      try {
        for (const file of selectedFiles) {
          try {
            await api.upload(ownerId, file);
            filesChanged = true;
          } catch (err) {
            uploadError = err instanceof Error ? err.message : String(err);
            break;
          }
        }
        if (controlled) {
          if (filesChanged) await onFilesChanged?.();
        } else {
          await load();
          if (filesChanged) await onFilesChanged?.();
        }
        if (uploadError) setError(uploadError);
      } finally {
        setUploading(false);
      }
    },
    [
      api,
      controlled,
      files.length,
      load,
      maxFiles,
      onFilesChanged,
      ownerId,
      uploadDisabled,
    ],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setDragOver(false);
      if (!event.dataTransfer?.files) return;
      void handleFiles(event.dataTransfer.files);
    },
    [handleFiles],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  return (
    <div className="space-y-3">
      <Button
        variant="ghost"
        aria-label="Upload files"
        disabled={uploadDisabled}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={[
          "relative h-auto w-full flex-col items-stretch gap-0 border border-dashed border-border/70 bg-muted/30 px-4 py-6 text-center font-normal whitespace-normal",
          "hover:bg-muted/50",
          dragOver ? "border-primary/60 bg-primary/8" : "",
          uploadDisabled ? "cursor-not-allowed opacity-60" : "",
        ].join(" ")}
      >
        <Upload className="mx-auto size-6 text-muted-foreground" />
        <div className="mt-2 text-sm font-medium text-foreground">
          {uploading ? "Uploading…" : fileLimitReached ? "Document limit reached" : "Drop files here"}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {helperText} Or{" "}
          <span className="text-primary-text underline">browse files</span>
        </div>
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={accept}
        disabled={uploadDisabled}
        tabIndex={-1}
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : files.length > 0 ? (
        <ul className="space-y-1.5">
          {files.map((file) => (
            <li key={file.name}>
              <PanelItem className="group flex items-center gap-2">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {file.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(file.size)} · {parseStatusLabel(file)}
                    {documentReviewLabel(file) ? ` · ${documentReviewLabel(file)}` : null}
                    {file.source?.kind === "mcp-resource" ? (
                      <>
                        {" · "}
                        <span
                          aria-label={`MCP resource from ${file.source.serverName}: ${file.source.resourceName}; ${file.source.resourceUri}`}
                          title={`${file.source.resourceName} · ${file.source.resourceUri}`}
                        >
                          MCP · {file.source.serverName}
                        </span>
                      </>
                    ) : null}
                  </div>
                  {file.source?.kind === "mcp-resource" ? (
                    <details className="mt-1 text-xs text-muted-foreground">
                      <summary
                        aria-label={`MCP provenance for ${file.name}`}
                        className="w-fit cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        MCP provenance
                      </summary>
                      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-md bg-muted/40 p-2">
                        <dt>Server</dt>
                        <dd className="truncate" title={file.source.serverName}>
                          {file.source.serverName}
                        </dd>
                        <dt>Resource</dt>
                        <dd className="truncate" title={file.source.resourceName}>
                          {file.source.resourceName}
                        </dd>
                        <dt>URI</dt>
                        <dd className="break-all font-mono">{file.source.resourceUri}</dd>
                        <dt>Captured</dt>
                        <dd>
                          <time dateTime={file.source.capturedAt}>{file.source.capturedAt}</time>
                        </dd>
                        <dt>MIME</dt>
                        <dd className="font-mono">{file.source.mimeType}</dd>
                        <dt>SHA-256</dt>
                        <dd className="break-all font-mono">{file.source.sha256}</dd>
                      </dl>
                    </details>
                  ) : null}
                </div>
                {file.parseStatus === "parsing" ? (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                ) : !file.usedAt ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${file.name}`}
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => {
                      void (async () => {
                        try {
                          await api.delete(ownerId, file.name);
                          if (controlled) {
                            await onFilesChanged?.();
                          } else {
                            await load();
                            await onFilesChanged?.();
                          }
                        } catch (err) {
                          setError(
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                      })();
                    }}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </PanelItem>
            </li>
          ))}
        </ul>
      ) : null}

      {files.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs text-muted-foreground"
          onClick={() =>
            void (controlled ? onFilesChanged?.() : load())
          }
          disabled={loading}
        >
          Refresh
        </Button>
      ) : null}
    </div>
  );
}

export default FileUpload;
