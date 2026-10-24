import { Folder, FolderPlus, Loader2, X } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";

import type { SharedFolderView } from "@contracts/shared-folders";
import { Button } from "@/components/ui/button";
import { SharedFolderName } from "@/components/shared/shared-folder-name";
import { PanelCard, PanelEmptyState, PanelItem } from "@/components/ui/card";
import {
  attachProjectFolder,
  browserRefreshTimer,
  detachProjectFolder,
  FOLDER_STATUS_REFRESH_MS,
  folderStatusText,
  isIndexing,
  listProjectFolders,
  needsAttention,
  type FolderRefreshTimer,
} from "@/lib/clients/shared-folders-client";
import { cn } from "@/lib/utils/utils";

/**
 * The Library project page's Shared folders card
 * (docs/feature-local-folder-access.md, "Library: Shared folders card").
 *
 * Every chat in the project gets these folders on its next turn. Folders are
 * added through the native picker, which records the grant the server checks;
 * the server's refusals are shown as they come.
 *
 * Each row shows the folder's status when the server sends one. While a
 * folder is indexing, the list is read again on the refresh timer.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One visit to a project's folders. The Library can give the card another
 * project, or show the project in a new card, while a request is under way.
 * Every response is checked against the visit that sent it: once the project
 * changes the visit is inactive and its responses change nothing.
 */
interface ProjectVisit {
  projectId: string;
  active: boolean;
  /** The newest folder list read. An older read's answer is dropped. */
  latestRead: number;
  /**
   * Folders removed during this visit. The server draws a new random ID for
   * every add, so an add answer naming one of these is older than the removal.
   */
  removed: Set<string>;
  /** Whether the last list read named a folder that is indexing. */
  indexing: boolean;
  /** Cancels the re-read waiting on the refresh timer, if there is one. */
  cancelRefresh: (() => void) | undefined;
}

function stopRefresh(visit: ProjectVisit): void {
  visit.cancelRefresh?.();
  visit.cancelRefresh = undefined;
}

/**
 * The visits on screen, each with the way it reads its list again. A change
 * can land after its project was left and shown again, so the change finds
 * the project's visit here, not through the visit that sent it.
 */
const shownVisits = new Map<ProjectVisit, () => void>();

/** Called once the server has applied a change to a project's folders. */
function rereadShownProject(projectId: string): void {
  for (const [visit, reread] of shownVisits) {
    if (visit.projectId === projectId) reread();
  }
}

/** The request a shown message describes. */
type FolderOperation = "read" | "attach" | "remove" | "open";

/** The card's message. Only a later success of the same request removes it. */
interface ShownError {
  message: string;
  operation: FolderOperation;
}

/** Removes the shown message if it describes `operation`, which has just succeeded. */
function clearedBy(operation: FolderOperation): (shown: ShownError | null) => ShownError | null {
  return (shown) => (shown?.operation === operation ? null : shown);
}

interface ProjectSharedFoldersProps {
  projectId: string;
  /** False for an archived project, which can't gain folders. */
  active: boolean;
  /** Schedules the re-reads while a folder is indexing. Tests pass a timer they run themselves. */
  refreshTimer?: FolderRefreshTimer | undefined;
}

export function ProjectSharedFolders({ projectId, active, refreshTimer = browserRefreshTimer }: ProjectSharedFoldersProps) {
  const headingId = useId();
  const noteId = useId();
  /** Null until the project's list has loaded. */
  const [folders, setFolders] = useState<SharedFolderView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShownError | null>(null);
  const visitRef = useRef<ProjectVisit | null>(null);
  const pickFolder = typeof window === "undefined" ? undefined : window.pipeline?.selectSharedFolder;
  // The server treats an archived project as read-only, so neither adding nor
  // removing a folder can succeed until it is restored.
  const blockedReason = !active
    ? "Restore this project to change its folders."
    : !pickFolder
      ? "Folders can be added only in the desktop app."
      : null;

  // The timer the next re-read uses, kept current for reads already under way.
  const refreshTimerRef = useRef(refreshTimer);
  useLayoutEffect(() => {
    refreshTimerRef.current = refreshTimer;
  }, [refreshTimer]);

  // Reads after an add or removal replace any older read still in flight, so
  // a list fetched before the change cannot hide it when it lands late. A new
  // read also replaces a waiting re-read. While a folder is indexing, the
  // current read schedules the next once it lands, failed or not, so the
  // card never has two re-reads in flight.
  const readFolders = useCallback(function readFolders(visit: ProjectVisit): void {
    visit.latestRead += 1;
    const read = visit.latestRead;
    stopRefresh(visit);
    const current = () => visit.active && visit.latestRead === read;
    const scheduleNextRead = () => {
      if (!visit.indexing) return;
      visit.cancelRefresh = refreshTimerRef.current.schedule(() => readFolders(visit), FOLDER_STATUS_REFRESH_MS);
    };
    void listProjectFolders(visit.projectId).then(
      (next) => {
        if (!current()) return;
        setFolders(next);
        setError(clearedBy("read"));
        visit.indexing = next.some(isIndexing);
        scheduleNextRead();
      },
      (nextError: unknown) => {
        if (!current()) return;
        setError({ message: errorMessage(nextError), operation: "read" });
        scheduleNextRead();
      },
    );
  }, []);

  // A layout effect, so the visit changes in the same commit that shows the
  // new project, and nothing from the old project is on screen with it.
  useLayoutEffect(() => {
    const visit: ProjectVisit = {
      projectId,
      active: true,
      latestRead: 0,
      removed: new Set(),
      indexing: false,
      cancelRefresh: undefined,
    };
    visitRef.current = visit;
    shownVisits.set(visit, () => readFolders(visit));
    readFolders(visit);
    return () => {
      visit.active = false;
      stopRefresh(visit);
      shownVisits.delete(visit);
      setFolders(null);
      setError(null);
      setBusy(false);
    };
  }, [projectId, readFolders]);

  const addFolder = async (): Promise<void> => {
    const visit = visitRef.current;
    if (!pickFolder || !active || !visit) return;
    setBusy(true);
    try {
      const picked = await pickFolder();
      if (!picked) return;
      const folder = await attachProjectFolder(visit.projectId, picked.path);
      if (visit.active) {
        setError(clearedBy("attach"));
        if (!visit.removed.has(folder.id)) {
          setFolders((current) => {
            const shown = current ?? [];
            return shown.some((entry) => entry.id === folder.id) ? shown : [...shown, folder];
          });
        }
      }
      rereadShownProject(visit.projectId);
    } catch (nextError) {
      if (visit.active) setError({ message: errorMessage(nextError), operation: "attach" });
    } finally {
      if (visit.active) setBusy(false);
    }
  };

  const removeFolder = async (folder: SharedFolderView): Promise<void> => {
    const visit = visitRef.current;
    if (!active || !visit) return;
    try {
      await detachProjectFolder(visit.projectId, folder.id);
      visit.removed.add(folder.id);
      if (visit.active) {
        setError(clearedBy("remove"));
        setFolders((current) => current && current.filter((entry) => entry.id !== folder.id));
      }
      rereadShownProject(visit.projectId);
    } catch (nextError) {
      if (visit.active) setError({ message: errorMessage(nextError), operation: "remove" });
    }
  };

  return (
    <PanelCard aria-labelledby={headingId} className="bg-transparent p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="font-heading text-sm font-semibold">Shared folders</h3>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={blockedReason !== null || busy}
          aria-describedby={blockedReason ? noteId : undefined}
          onClick={() => void addFolder()}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FolderPlus aria-hidden="true" />}
          Add folder
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Every chat in this project can search and read these folders. Files are never changed.
      </p>
      {blockedReason ? (
        <p id={noteId} className="mt-1 text-xs text-muted-foreground">
          {blockedReason}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {folders === null ? null : folders.length === 0 ? (
        <PanelEmptyState className="mt-3 bg-transparent text-sm text-muted-foreground">
          No folders yet. Add a folder to let this project's chats search and read it.
        </PanelEmptyState>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {folders.map((folder) => {
            const statusText = folderStatusText(folder.status);
            return (
              <li key={folder.id}>
                <PanelItem className="flex items-center gap-2">
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <SharedFolderName
                      label={folder.label}
                      folderPath={folder.path}
                      className="block max-w-full text-xs font-medium"
                      onOpened={() => setError(clearedBy("open"))}
                      onOpenFailed={(message) => setError({ message, operation: "open" })}
                    />
                    <div className="truncate text-xs text-muted-foreground" title={folder.path}>
                      {folder.path}
                    </div>
                  </div>
                  {statusText ? (
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        needsAttention(folder) ? "text-destructive/80" : "text-muted-foreground",
                      )}
                    >
                      {statusText}
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${folder.label}`}
                    disabled={!active}
                    aria-describedby={active ? undefined : noteId}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void removeFolder(folder)}
                  >
                    <X />
                  </Button>
                </PanelItem>
              </li>
            );
          })}
        </ul>
      )}
    </PanelCard>
  );
}
