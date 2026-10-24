import {
  sharedFolderGrantListResponseSchema,
  sharedFolderListResponseSchema,
  sharedFolderViewSchema,
  type SharedFolderGrantView,
  type SharedFolderStatus,
  type SharedFolderView,
} from "@contracts/shared-folders";
import { getApiBaseUrl } from "@/lib/utils/desktop";

/**
 * Folders shared with one chat or one project
 * (docs/feature-local-folder-access.md). A chat's list also names the folders
 * it gets from its project, first, with source "project".
 */

/**
 * How long a folder list waits, after a read has landed, before it is read
 * again while one of its folders is indexing. The wait starts only once the
 * previous read has landed, so a list never has two re-reads in flight.
 */
export const FOLDER_STATUS_REFRESH_MS = 3_000;

/** Runs a list's next re-read later, and returns a function that cancels it. */
export interface FolderRefreshTimer {
  schedule(callback: () => void, delayMs: number): () => void;
}

export const browserRefreshTimer: FolderRefreshTimer = {
  schedule(callback, delayMs) {
    const handle = window.setTimeout(callback, delayMs);
    return () => window.clearTimeout(handle);
  },
};

export function isIndexing(folder: SharedFolderView): boolean {
  return folder.status?.state === "indexing";
}

/** A folder the agent can't reach: moved or deleted, its access removed, or unreadable. */
export function needsAttention(folder: SharedFolderView): boolean {
  return folder.status?.state === "unavailable";
}

const UNAVAILABLE_TEXT: Record<NonNullable<SharedFolderStatus["reason"]>, string> = {
  not_found: "Folder not found",
  access_removed: "Access removed",
  unreadable: "Can't read folder",
};

function counted(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/**
 * The text a folder row shows for its status ("Status" in the feature
 * document), or undefined when the server sent none.
 */
export function folderStatusText(status: SharedFolderStatus | undefined): string | undefined {
  if (!status) return undefined;
  const files = status.files === undefined ? [] : [counted(status.files, "file", "files")];
  switch (status.state) {
    case "unavailable":
      return status.reason ? UNAVAILABLE_TEXT[status.reason] : "Unavailable";
    case "ready":
      return [...files, "Ready"].join(" · ");
    case "indexing": {
      const left = status.pendingDocuments === undefined
        ? []
        : [`${counted(status.pendingDocuments, "document", "documents")} left`];
      return [...files, "Indexing", ...left].join(" · ");
    }
    case "partial":
      return [...files, status.limit ? `Partial: ${status.limit}` : "Partial"].join(" · ");
  }
}

function foldersUrl(owner: "sessions" | "projects", ownerId: string, folderId?: string): string {
  const base = `${getApiBaseUrl()}/${owner}/${encodeURIComponent(ownerId)}/folders`;
  return folderId === undefined ? base : `${base}/${encodeURIComponent(folderId)}`;
}

/** A folder request the server refused, with its reason and code. */
export class SharedFoldersClientError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "SharedFoldersClientError";
    this.code = code;
  }
}

async function requestFailure(response: Response, fallback: string): Promise<SharedFoldersClientError> {
  const payload: unknown = await response.json().catch(() => null);
  const body = typeof payload === "object" && payload !== null ? payload : {};
  const message = "error" in body && typeof body.error === "string" ? body.error : `${fallback} (${response.status})`;
  return new SharedFoldersClientError(message, "code" in body && typeof body.code === "string" ? body.code : undefined);
}

export async function listSessionFolders(sessionId: string): Promise<SharedFolderView[]> {
  const response = await fetch(foldersUrl("sessions", sessionId));
  if (!response.ok) throw await requestFailure(response, "Could not load folders");
  return sharedFolderListResponseSchema.parse(await response.json()).folders;
}

/** Attaches a folder the native picker has just granted. */
export async function attachSessionFolder(sessionId: string, folderPath: string): Promise<SharedFolderView> {
  const response = await fetch(foldersUrl("sessions", sessionId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: folderPath }),
  });
  if (!response.ok) throw await requestFailure(response, "Could not add the folder");
  return sharedFolderViewSchema.parse(await response.json());
}

export async function detachSessionFolder(sessionId: string, folderId: string): Promise<void> {
  const response = await fetch(foldersUrl("sessions", sessionId, folderId), { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw await requestFailure(response, "Could not remove the folder");
  }
}

export async function listProjectFolders(projectId: string): Promise<SharedFolderView[]> {
  const response = await fetch(foldersUrl("projects", projectId));
  if (!response.ok) throw await requestFailure(response, "Could not load folders");
  return sharedFolderListResponseSchema.parse(await response.json()).folders;
}

/** Shares a folder the native picker has just granted with every chat in the project. */
export async function attachProjectFolder(projectId: string, folderPath: string): Promise<SharedFolderView> {
  const response = await fetch(foldersUrl("projects", projectId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: folderPath }),
  });
  if (!response.ok) throw await requestFailure(response, "Could not add the folder");
  return sharedFolderViewSchema.parse(await response.json());
}

export async function detachProjectFolder(projectId: string, folderId: string): Promise<void> {
  const response = await fetch(foldersUrl("projects", projectId, folderId), { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw await requestFailure(response, "Could not remove the folder");
  }
}

/** The folders picked for sharing, as Settings lists them. Separate from Batch's grants. */
export async function listSharedFolderGrants(): Promise<SharedFolderGrantView[]> {
  const response = await fetch(`${getApiBaseUrl()}/settings/shared-folder-grants`);
  if (!response.ok) throw await requestFailure(response, "Could not load shared folders");
  return sharedFolderGrantListResponseSchema.parse(await response.json()).grants;
}

/** Revokes a grant. Agents lose the folder on their next tool call; it stays attached to its chats and projects. */
export async function revokeSharedFolderGrant(folderPath: string): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/settings/shared-folder-grants`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: folderPath }),
  });
  if (!response.ok) throw await requestFailure(response, "Could not revoke folder access");
}
