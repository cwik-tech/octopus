import {
  getMediaCategory,
  mediaCategoryIcons,
  type AttachmentMediaCategory,
} from "@/components/ai-elements/attachments";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/utils";

import { scrollToFileCard } from "./file-card-anchor";
import type { FileTimelineItem } from "./use-file-upload-controller";

interface FileIconBarProps {
  items: FileTimelineItem[];
  className?: string;
}

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  m4a: "audio/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  png: "image/png",
  svg: "image/svg+xml",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
};

const mimeTypeForItem = (item: FileTimelineItem): string => {
  if (item.file?.source?.kind === "mcp-resource") {
    return item.file.source.mimeType;
  }
  const extension = item.filename.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MEDIA_TYPES[extension] ?? "application/octet-stream";
};

const mediaCategoryForItem = (
  item: FileTimelineItem,
): AttachmentMediaCategory =>
  getMediaCategory({
    type: "file",
    id: item.key,
    mediaType: mimeTypeForItem(item),
    url: "",
    filename: item.filename,
  });

/**
 * Compact icon row of current live files only. Each button scrolls to the
 * matching attachment card through the anchor util.
 */
export function FileIconBar({ items, className }: FileIconBarProps) {
  const currentItems = items.filter((item) => item.state === "current");
  if (currentItems.length === 0) return null;

  return (
    <div
      aria-label="Current files"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {currentItems.map((item) => {
        const Icon = mediaCategoryIcons[mediaCategoryForItem(item)];
        return (
          <Tooltip key={item.key}>
            <TooltipTrigger
              type="button"
              aria-label={`Scroll to ${item.filename}`}
              onClick={() => scrollToFileCard(item.key)}
              className="inline-flex size-7 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="top">{item.filename}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
