import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/utils";

/**
 * A shared folder's name. In the desktop app it opens the folder in Finder or
 * File Explorer; without the desktop bridge it is plain text. Electron's main
 * process opens only folders the person granted, whatever path is sent.
 */

function fileManagerName(): string {
  if (typeof navigator === "undefined") return "the file manager";
  if (/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)) return "Finder";
  if (/Windows/i.test(navigator.userAgent)) return "File Explorer";
  return "the file manager";
}

/** Electron prefixes a main-process error with the channel; the person needs only the reason. */
function openFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

export function SharedFolderName({
  label,
  folderPath,
  className,
  onOpened,
  onOpenFailed,
}: {
  label: string;
  folderPath: string;
  className?: string;
  onOpened: () => void;
  onOpenFailed: (message: string) => void;
}) {
  const openFolder = typeof window === "undefined" ? undefined : window.pipeline?.openSharedFolder;
  if (!openFolder) {
    return (
      <span className={cn("min-w-0 truncate", className)} title={folderPath}>
        {label}
      </span>
    );
  }
  return (
    <Button
      variant="link"
      aria-label={`Show ${label} in ${fileManagerName()}`}
      title={folderPath}
      className={cn("h-auto min-w-0 justify-start truncate p-0 font-normal text-foreground", className)}
      onClick={() => {
        openFolder(folderPath).then(onOpened, (error: unknown) => onOpenFailed(openFailureMessage(error)));
      }}
    >
      <span className="truncate">{label}</span>
    </Button>
  );
}
