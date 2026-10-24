import { CircleAlert, Folder, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { SharedFolderGrantView } from "@contracts/shared-folders";
import { Button } from "@/components/ui/button";
import { PanelCard, PanelEmptyState, PanelItem } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listSharedFolderGrants, revokeSharedFolderGrant } from "@/lib/clients/shared-folders-client";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The folders picked for sharing with agents (docs/feature-local-folder-access.md,
 * "The person revokes the grant in Settings").
 *
 * A grant is what lets an agent read a folder. Revoking it stops the next
 * folder tool call, even in a reply that is already running. The folder stays
 * attached to its chats and projects until it is removed there. Batch keeps its
 * own grants in the Batch folders section.
 */
export function SharedFolderSettings() {
  const headingId = useId();
  const [grants, setGrants] = useState<SharedFolderGrantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokePath, setRevokePath] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setGrants(await listSharedFolderGrants());
    } catch (loadError) {
      setError(errorMessage(loadError, "Shared folders could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void listSharedFolderGrants()
      .then((next) => {
        if (active) setGrants(next);
      })
      .catch((loadError: unknown) => {
        if (active) setError(errorMessage(loadError, "Shared folders could not be loaded."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function revoke(): Promise<void> {
    if (!revokePath) return;
    const revoked = revokePath;
    setRevoking(true);
    setError(null);
    try {
      await revokeSharedFolderGrant(revoked);
      setGrants((current) => current.filter((grant) => grant.path !== revoked));
    } catch (revokeError) {
      setError(errorMessage(revokeError, "Folder access could not be revoked."));
    } finally {
      setRevoking(false);
      // Closed either way, so a failure is read beside the row it left in place.
      setRevokePath(null);
    }
  }

  return (
    <>
      <PanelCard aria-labelledby={headingId} className="space-y-4 bg-transparent p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={headingId} className="font-medium">Shared folders</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Folders you picked with Add folder in a chat or a project. Agents can search and read them.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            Refresh
          </Button>
        </div>
        {loading && grants.length === 0 ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading shared folders…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <CircleAlert className="size-4" />
            {error}
          </p>
        ) : null}
        {!loading && grants.length === 0 && !error ? (
          <PanelEmptyState className="bg-transparent text-sm text-muted-foreground">
            No folders have been shared with agents.
          </PanelEmptyState>
        ) : null}
        {grants.length > 0 ? (
          <ul className="space-y-2">
            {grants.map((grant) => (
              <li key={grant.path}>
                <PanelItem className="flex items-center gap-3">
                  <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <code className="min-w-0 flex-1 truncate text-xs" title={grant.path}>{grant.path}</code>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Revoke ${grant.path}`}
                    onClick={() => setRevokePath(grant.path)}
                  >
                    <Trash2 className="size-4" />
                    Revoke
                  </Button>
                </PanelItem>
              </li>
            ))}
          </ul>
        ) : null}
      </PanelCard>
      <Dialog
        open={revokePath !== null}
        onOpenChange={(open) => {
          if (!open && !revoking) setRevokePath(null);
        }}
      >
        <DialogContent showCloseButton={!revoking}>
          <DialogHeader>
            <DialogTitle>Revoke folder access?</DialogTitle>
            <DialogDescription>
              Agents lose this folder on their next file request, even in a reply that is already running. The
              folder stays attached to its chats and projects until you remove it there.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={revoking} />}>Keep access</DialogClose>
            <Button variant="destructive" disabled={revoking} onClick={() => void revoke()}>
              {revoking ? "Revoking…" : "Revoke folder access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
