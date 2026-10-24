import { CircleAlert, FileText, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { memo, useState } from "react";

import {
  formatBytes,
  parseStatusLabel,
  documentReviewLabel,
} from "@/components/shared/file-format";
import { Button } from "@/components/ui/button";
import type { SessionFile } from "@/lib/models/session-model";
import { formatTimestamp } from "@/lib/models/runtime-model";
import { cn } from "@/lib/utils/utils";

import { fileCardAnchorId } from "./file-card-anchor";
import type { FileTimelineItem } from "./use-file-upload-controller";

interface FileMessageCardProps {
  item: FileTimelineItem;
  onRetry?: (item: FileTimelineItem) => void;
  onDismiss?: (item: FileTimelineItem) => void;
  onDelete?: (item: FileTimelineItem) => boolean | Promise<boolean>;
  className?: string;
}

/**
 * Right-aligned, user-owned attachment card. Pure presentation: it receives a
 * display-only FileTimelineItem and never a chat-attachment type.
 */
export const FileMessageCard = memo(function FileMessageCard({
  item,
  onRetry,
  onDismiss,
  onDelete,
  className,
}: FileMessageCardProps) {
  const file = item.file;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = async () => {
    if (!onDelete || deleting) return;
    setDeleting(true);
    try {
      const deleted = await onDelete(item);
      if (deleted) setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      id={fileCardAnchorId(item.key)}
      data-testid="file-message-card"
      data-state={item.state}
      className={cn(
        "group ml-auto flex w-fit max-w-[85%] min-w-0 flex-col gap-1 rounded-lg bg-secondary px-4 py-3 text-sm text-foreground",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {item.state === "uploading" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-sm font-medium">{item.filename}</span>
        {item.state === "current" &&
        file &&
        !file.usedAt &&
        file.parseStatus !== "parsing" &&
        onDelete ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Delete ${item.filename}`}
            className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>

      <div className="text-xs text-muted-foreground">
        {formatBytes(item.size)} · {formatTimestamp(item.occurredAt)}
        {item.state === "uploading" ? " · uploading…" : null}
        {item.state === "current" && file ? ` · ${parseStatusLabel(file)}` : null}
        {item.state === 'current' && file && documentReviewLabel(file) ? ` · ${documentReviewLabel(file)}` : null}
      </div>

      {file?.source?.kind === "mcp-resource" ? (
        <McpProvenance file={file} />
      ) : null}

      {confirmingDelete ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/8 px-2.5 py-2 text-xs">
          <span className="mr-1 text-destructive">Delete this file?</span>
          <Button
            variant="destructive"
            size="xs"
            disabled={deleting}
            onClick={() => void confirmDelete()}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={deleting}
            onClick={() => setConfirmingDelete(false)}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {item.state === "error" ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{item.error ?? "Upload failed"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {item.retryFile && onRetry ? (
              <Button
                variant="outline"
                size="xs"
                aria-label={`Retry ${item.filename}`}
                onClick={() => onRetry(item)}
              >
                <RotateCcw />
                Retry
              </Button>
            ) : null}
            {onDismiss ? (
              <Button
                variant="outline"
                size="xs"
                aria-label={`Dismiss ${item.filename}`}
                className="text-muted-foreground"
                onClick={() => onDismiss(item)}
              >
                <X />
                Dismiss
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
});

function McpProvenance({ file }: { file: SessionFile }) {
  const source = file.source;
  if (source?.kind !== "mcp-resource") return null;
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary
        aria-label={`MCP provenance for ${file.name}`}
        className="w-fit cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        MCP · {source.serverName} — provenance
      </summary>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-md bg-muted/40 p-2">
        <dt>Server</dt>
        <dd className="truncate" title={source.serverName}>
          {source.serverName}
        </dd>
        <dt>Resource</dt>
        <dd className="truncate" title={source.resourceName}>
          {source.resourceName}
        </dd>
        <dt>URI</dt>
        <dd className="break-all font-mono">{source.resourceUri}</dd>
        <dt>Captured</dt>
        <dd>
          <time dateTime={source.capturedAt}>{source.capturedAt}</time>
        </dd>
        <dt>MIME</dt>
        <dd className="font-mono">{source.mimeType}</dd>
        <dt>SHA-256</dt>
        <dd className="break-all font-mono">{source.sha256}</dd>
      </dl>
    </details>
  );
}
