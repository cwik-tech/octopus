import { CircleAlert, FolderOpen, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listBatchFolderGrants, revokeBatchFolderGrant } from "@/lib/clients/batch-folder-grants-client";
import type { BatchFolderGrantView } from "@contracts/batches";

export function BatchFolderSettings() {
  const [grants, setGrants] = useState<BatchFolderGrantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokePath, setRevokePath] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setGrants(await listBatchFolderGrants());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Batch folder grants could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void listBatchFolderGrants()
      .then((next) => {
        if (active) setGrants(next);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Batch folder grants could not be loaded.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function revoke(): Promise<void> {
    if (!revokePath) return;
    setRevoking(true);
    setError(null);
    try {
      await revokeBatchFolderGrant(revokePath);
      setGrants((current) => current.filter((grant) => grant.path !== revokePath));
      setRevokePath(null);
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Batch folder access could not be revoked.");
    } finally {
      setRevoking(false);
    }
  }

  return <>
    <section className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-5">
      <div className="flex items-start justify-between gap-4"><div><h2 className="font-medium">External folder grants</h2><p className="mt-1 text-sm text-muted-foreground">Folders selected through the desktop picker and available to Batch definitions.</p></div><Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />Refresh</Button></div>
      {loading && grants.length === 0 ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading Batch folders…</p> : null}
      {error ? <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><CircleAlert className="size-4" />{error}</p> : null}
      {!loading && grants.length === 0 && !error ? <p className="text-sm text-muted-foreground">No external folders have been granted. Workspace folders do not need grants.</p> : null}
      <div className="space-y-2">{grants.map((grant) => <div key={grant.path} className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2"><FolderOpen className="size-4 shrink-0 text-muted-foreground" /><code className="min-w-0 flex-1 truncate text-xs">{grant.path}</code><Button size="sm" variant="outline" aria-label={`Revoke ${grant.path}`} onClick={() => setRevokePath(grant.path)}><Trash2 className="size-4" />Revoke</Button></div>)}</div>
    </section>
    <Dialog open={revokePath !== null} onOpenChange={(open) => { if (!open && !revoking) setRevokePath(null); }}>
      <DialogContent showCloseButton={!revoking}><DialogHeader><DialogTitle>Revoke Batch folder access?</DialogTitle><DialogDescription>New Batch runs from this folder will be blocked. Already admitted tasks may finish; pending files fail closed.</DialogDescription></DialogHeader><DialogFooter><DialogClose render={<Button variant="outline" disabled={revoking} />}>Keep access</DialogClose><Button variant="destructive" disabled={revoking} onClick={() => void revoke()}>{revoking ? "Revoking…" : "Revoke folder access"}</Button></DialogFooter></DialogContent>
    </Dialog>
  </>;
}
