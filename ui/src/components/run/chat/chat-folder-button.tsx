import { Folder, FolderOpen, FolderPlus, Loader2, TriangleAlert, X } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";

import { SHARED_FOLDER_ALREADY_IN_PROJECT, type SharedFolderView } from "@contracts/shared-folders";
import { HeaderIconButton } from "@/components/sidebar/header-icon-button";
import { Button } from "@/components/ui/button";
import { SharedFolderName } from "@/components/shared/shared-folder-name";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  attachSessionFolder,
  browserRefreshTimer,
  detachSessionFolder,
  FOLDER_STATUS_REFRESH_MS,
  folderStatusText,
  isIndexing,
  listSessionFolders,
  needsAttention,
  SharedFoldersClientError,
  type FolderRefreshTimer,
} from "@/lib/clients/shared-folders-client";
import { cn } from "@/lib/utils/utils";

/**
 * The chat header's folder control (docs/feature-local-folder-access.md).
 *
 * With no folders it opens the native picker straight away. With folders it
 * shows a count and a popover listing them. The agent reads attached folders
 * through tools on its next turn; nothing here is sent with a message.
 *
 * A draft chat has no folders on the server, so the button asks for none.
 * Choosing a folder saves the chat first, the way attaching a file does in
 * the chat panel, and the folder goes to the chat the draft was saved as.
 *
 * A chat in a project also gets that project's folders. The server lists them
 * first, and they are shown and counted here but managed only in the Library.
 * A chat moved into, out of or between projects gets the new project's folders
 * on its next turn, so the list is read again when the chat's project changes.
 *
 * Each folder shows its status when the server sends one, and the button
 * shows a warning while any folder is unavailable. While a folder is
 * indexing, the list is read again on the refresh timer.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `entry` is the chat's own folder `folderId`. Folder IDs are labels
 * within one list, so a project folder can carry the same ID as one of the
 * chat's own; a change to the chat's own folders never touches it.
 */
function isOwnFolder(entry: SharedFolderView, folderId: string): boolean {
  return entry.source === "session" && entry.id === folderId;
}

/**
 * One visit to a chat's folders. The run panel mounts a new button for each
 * chat, and a button can also be given another chat. Either way every response
 * is checked against the visit that sent it: once the chat changes the visit
 * is inactive and its responses change nothing.
 */
interface FolderVisit {
  sessionId: string;
  active: boolean;
  /** The chat's project when its list was last asked for. A move reads the list again. */
  projectId: string | undefined;
  /** The newest folder list read. An older read's answer is dropped. */
  latestRead: number;
  /**
   * Folders removed during this visit. The server draws a new random ID for
   * every attach, so an attach answer naming one of these is older than the
   * removal.
   */
  removed: Set<string>;
  /** Whether the last list read named a folder that is indexing. */
  indexing: boolean;
  /** Cancels the re-read waiting on the refresh timer, if there is one. */
  cancelRefresh: (() => void) | undefined;
}

function stopRefresh(visit: FolderVisit): void {
  visit.cancelRefresh?.();
  visit.cancelRefresh = undefined;
}

/**
 * The visits on screen, each with the way it reads its list again. A change
 * can land after its chat was left and opened again, by then in a new button,
 * so the change finds the chat's visit here, not through the button that sent
 * it.
 */
const shownVisits = new Map<FolderVisit, () => void>();

/**
 * Called once the server has applied a change to a chat's folders. The visit
 * showing that chat may have read its list before the change landed, so it
 * reads again.
 */
function rereadShownChat(sessionId: string): void {
  for (const [visit, reread] of shownVisits) {
    if (visit.sessionId === sessionId) reread();
  }
}

/** The request a message under the button describes. */
type FolderOperation = "read" | "attach" | "remove" | "open";

/** The message under the button. Only a later success of the same request removes it. */
interface ShownError {
  message: string;
  operation: FolderOperation;
}

/** Removes the shown message if it describes `operation`, which has just succeeded. */
function clearedBy(operation: FolderOperation): (shown: ShownError | null) => ShownError | null {
  return (shown) => (shown?.operation === operation ? null : shown);
}

interface ChatFolderButtonProps {
  sessionId: string | undefined;
  /** The project the chat is in, if any. The sidebar changes it after moving the chat on the server. */
  projectId?: string | undefined;
  /** The chat exists only on the client until it is first saved. */
  isDraft?: boolean | undefined;
  /** Saves a draft chat and returns the ID it was saved under (the chat panel's `ensureSession`). */
  ensureSession?: (() => Promise<string>) | undefined;
  /** Schedules the re-reads while a folder is indexing. Tests pass a timer they run themselves. */
  refreshTimer?: FolderRefreshTimer | undefined;
}

export function ChatFolderButton({
  sessionId,
  projectId,
  isDraft = false,
  ensureSession,
  refreshTimer = browserRefreshTimer,
}: ChatFolderButtonProps) {
  const projectHeadingId = useId();
  const ownHeadingId = useId();
  const [folders, setFolders] = useState<SharedFolderView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShownError | null>(null);
  const [open, setOpen] = useState(false);
  const visitRef = useRef<FolderVisit | null>(null);
  const pickFolder = typeof window === "undefined" ? undefined : window.pipeline?.selectSharedFolder;

  // The timer the next re-read uses, kept current for reads already under way.
  const refreshTimerRef = useRef(refreshTimer);
  useLayoutEffect(() => {
    refreshTimerRef.current = refreshTimer;
  }, [refreshTimer]);

  // Reads after an attach or removal replace any older read still in flight,
  // so a list fetched before the change cannot hide it when it lands late. A
  // new read, such as the one after a project move, also replaces a waiting
  // re-read. While a folder is indexing, the current read schedules the next
  // once it lands, failed or not, so the button never has two re-reads in
  // flight.
  const readFolders = useCallback(function readFolders(visit: FolderVisit): void {
    visit.latestRead += 1;
    const read = visit.latestRead;
    stopRefresh(visit);
    const current = () => visit.active && visit.latestRead === read;
    const scheduleNextRead = () => {
      if (!visit.indexing) return;
      visit.cancelRefresh = refreshTimerRef.current.schedule(() => readFolders(visit), FOLDER_STATUS_REFRESH_MS);
    };
    void listSessionFolders(visit.sessionId).then(
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

  // Whether the chat was a draft when its visit started: a draft has no list
  // to read. Saving a draft keeps its visit, so the attach that saved it still
  // shows its folder when it lands. Declared before the visit's effect, so it
  // is current when that effect runs.
  const isDraftRef = useRef(isDraft);
  useLayoutEffect(() => {
    isDraftRef.current = isDraft;
  }, [isDraft]);

  // The chat's project, for the visit's effect, which starts with the list
  // as it is for that project. Declared before that effect for the same reason.
  const projectIdRef = useRef(projectId);
  useLayoutEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  // A layout effect, so the visit changes in the same commit that shows the
  // new chat. With a passive effect, a click or a response could land after
  // the new chat is on screen but while the old visit was still active, or
  // while the old chat's list was still on screen with the new visit active.
  useLayoutEffect(() => {
    if (!sessionId) return;
    const visit: FolderVisit = {
      sessionId,
      active: true,
      projectId: projectIdRef.current,
      latestRead: 0,
      removed: new Set(),
      indexing: false,
      cancelRefresh: undefined,
    };
    visitRef.current = visit;
    shownVisits.set(visit, () => readFolders(visit));
    if (!isDraftRef.current) readFolders(visit);
    return () => {
      visit.active = false;
      stopRefresh(visit);
      shownVisits.delete(visit);
      setFolders([]);
      setError(null);
      setBusy(false);
    };
  }, [sessionId, readFolders]);

  // A chat moved into, out of or between projects stays on screen with its
  // new project, which the server already holds. Its list is read again in
  // the same visit: its own folders and any change in flight are still its
  // own, and the new read replaces any read sent before the move. A chat
  // switch that also changes the project has just been read by its new visit.
  useLayoutEffect(() => {
    const visit = visitRef.current;
    if (!visit?.active || visit.projectId === projectId) return;
    visit.projectId = projectId;
    if (!isDraftRef.current) readFolders(visit);
  }, [projectId, readFolders]);

  // The popover goes away with the list it shows: when the list empties, on a
  // chat switch or after the last removal, it closes, so the next list does
  // not open it without a click.
  if (open && folders.length === 0) setOpen(false);

  if (!sessionId) return null;

  const addFolder = async (): Promise<void> => {
    const visit = visitRef.current;
    if (!pickFolder || !visit) return;
    const saveDraft = isDraft ? ensureSession : undefined;
    setBusy(true);
    try {
      const picked = await pickFolder();
      if (!picked) return;
      if (saveDraft) {
        // A draft's folder goes only to the chat the draft is saved as, which
        // keeps the draft's ID. The save acts on whichever chat is selected,
        // and the selection can move one render before this button leaves the
        // draft. So a draft left while the picker was open stays unsaved, and
        // a save that names another chat, or ends after the draft was left,
        // attaches nothing.
        if (!visit.active) return;
        const savedId = await saveDraft();
        if (savedId !== visit.sessionId || !visit.active) return;
      }
      const folder = await attachSessionFolder(visit.sessionId, picked.path);
      if (visit.active) {
        setError(clearedBy("attach"));
        if (!visit.removed.has(folder.id)) {
          setFolders((current) => current.some((entry) => isOwnFolder(entry, folder.id)) ? current : [...current, folder]);
        }
      }
      rereadShownChat(visit.sessionId);
    } catch (nextError) {
      if (visit.active) setError({ message: errorMessage(nextError), operation: "attach" });
      // The project shares the folder already, so this chat's list is older
      // than the project's: read it again to show the folder the refusal names.
      if (nextError instanceof SharedFoldersClientError && nextError.code === SHARED_FOLDER_ALREADY_IN_PROJECT) {
        rereadShownChat(visit.sessionId);
      }
    } finally {
      if (visit.active) setBusy(false);
    }
  };

  const removeFolder = async (folder: SharedFolderView): Promise<void> => {
    const visit = visitRef.current;
    if (!visit) return;
    try {
      await detachSessionFolder(visit.sessionId, folder.id);
      visit.removed.add(folder.id);
      if (visit.active) {
        setError(clearedBy("remove"));
        setFolders((current) => current.filter((entry) => !isOwnFolder(entry, folder.id)));
      }
      rereadShownChat(visit.sessionId);
    } catch (nextError) {
      if (visit.active) setError({ message: errorMessage(nextError), operation: "remove" });
    }
  };

  const projectFolders = folders.filter((folder) => folder.source === "project");
  const ownFolders = folders.filter((folder) => folder.source === "session");
  const projectName = projectFolders[0]?.projectName;
  const unavailable = folders.filter(needsAttention).length;
  const triggerLabel = unavailable === 0
    ? `Attached folders (${folders.length})`
    : `Attached folders (${folders.length}), ${unavailable} ${unavailable === 1 ? "needs" : "need"} attention`;

  const statusOf = (folder: SharedFolderView) => {
    const text = folderStatusText(folder.status);
    return text ? (
      <span
        className={cn(
          "shrink-0 text-xs",
          needsAttention(folder) ? "text-destructive/80" : "text-muted-foreground",
        )}
      >
        {text}
      </span>
    ) : null;
  };

  const errorText = error ? (
    <p role="alert" className="max-w-64 truncate text-xs text-destructive" title={error.message}>
      {error.message}
    </p>
  ) : null;

  if (folders.length === 0) {
    return (
      <div className="flex items-center gap-2">
        {errorText}
        <HeaderIconButton
          label={pickFolder ? "Add folder" : "Add folder (desktop app only)"}
          disabled={!pickFolder || busy}
          onClick={() => void addFolder()}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
        </HeaderIconButton>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {errorText}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={triggerLabel}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            />
          }
        >
          <FolderOpen className="size-4" />
          <span className="text-xs tabular-nums">{folders.length}</span>
          {unavailable > 0 ? <TriangleAlert className="size-3.5 text-destructive/80" aria-hidden="true" /> : null}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80" aria-label="Attached folders">
          {projectFolders.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p id={projectHeadingId} className="text-xs font-medium text-muted-foreground">
                {projectName ? `From project "${projectName}"` : "From this chat's project"}
              </p>
              <ul aria-labelledby={projectHeadingId} className="flex flex-col gap-0.5">
                {projectFolders.map((folder) => (
                  <li key={folder.id} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1">
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <SharedFolderName
                      label={folder.label}
                      folderPath={folder.path}
                      className="flex-1"
                      onOpened={() => setError(clearedBy("open"))}
                      onOpenFailed={(message) => setError({ message, operation: "open" })}
                    />
                    {statusOf(folder)}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">Manage these in Library</p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            {ownFolders.length > 0 ? (
              <>
                <p id={ownHeadingId} className="text-xs font-medium text-muted-foreground">This chat only</p>
                <ul aria-labelledby={ownHeadingId} className="flex flex-col gap-0.5">
                  {ownFolders.map((folder) => (
                    <li key={folder.id} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1">
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <SharedFolderName
                        label={folder.label}
                        folderPath={folder.path}
                        className="flex-1"
                        onOpened={() => setError(clearedBy("open"))}
                        onOpenFailed={(message) => setError({ message, operation: "open" })}
                      />
                      {statusOf(folder)}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${folder.label}`}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => void removeFolder(folder)}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="text-xs text-muted-foreground">
              The agent can search and read these folders. Files are never changed.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!pickFolder || busy}
            onClick={() => void addFolder()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <FolderPlus />}
            Add folder
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
