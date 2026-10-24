import { CircleAlert, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils/utils";
import { Button } from "@/components/ui/button";

interface FileUploadNoticeProps {
  error: string | null;
  loading: boolean;
  uploading: boolean;
  onDismissError: () => void;
  className?: string;
}

/** Visible, dismissible feedback for controller-level file operations. */
export function FileUploadNotice({
  error,
  loading,
  uploading,
  onDismissError,
  className,
}: FileUploadNoticeProps) {
  if (!error && !loading && !uploading) return null;

  if (error) {
    return (
      <div
        className={cn(
          "mb-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive",
          className,
        )}
        role="alert"
      >
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{error}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss file error"
          className="size-5"
          onClick={onDismissError}
        >
          <X />
        </Button>
      </div>
    );
  }

  return (
    <div
      aria-live="polite"
      className={cn(
        "mb-2 flex items-center gap-2 text-xs text-muted-foreground",
        className,
      )}
      role="status"
    >
      <Loader2 className="size-3.5 animate-spin" />
      {loading ? "Loading files…" : "Uploading files…"}
    </div>
  );
}
