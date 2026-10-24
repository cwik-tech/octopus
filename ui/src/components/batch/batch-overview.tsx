import { CircleAlert, Download, ExternalLink, Loader2, Pencil, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { OverviewPanel, OverviewRow, OverviewSection, type OverviewHeaderTabs } from "@/components/overview/overview-panel";
import { Badge } from "@/components/ui/badge";
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
import type { BatchesState } from "@/components/batch/use-batches";
import { PanelEmptyState } from "@/components/ui/card";
import { batchArtifactUrl } from "@/lib/clients/batches-client";
import { formatDisplayName } from "@/lib/utils/display-name";
import type { BatchExecutionSummary, BatchView } from "@contracts/batches";

type Confirmation =
  | { kind: "run"; batch: BatchView; fileCount: number; totalBytes: number }
  | { kind: "delete"; batch: BatchView }
  | { kind: "clear"; batch: BatchView; execution: BatchExecutionSummary };

export function BatchOverview({
  onEdit,
  onNew,
  onOpenSession,
  state,
  tabs,
}: {
  onEdit(batch: BatchView): void;
  onNew(): void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  state: BatchesState;
  tabs?: OverviewHeaderTabs | undefined;
}) {
  const [busyBatchIds, setBusyBatchIds] = useState<ReadonlySet<string>>(() => new Set());
  const busyBatchIdsRef = useRef(new Set<string>());
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const { batches, executionDetails, loadExecution } = state;

  function beginBatchAction(batchId: string): boolean {
    if (busyBatchIdsRef.current.has(batchId)) return false;
    busyBatchIdsRef.current.add(batchId);
    setBusyBatchIds(new Set(busyBatchIdsRef.current));
    return true;
  }

  function endBatchAction(batchId: string): void {
    busyBatchIdsRef.current.delete(batchId);
    setBusyBatchIds(new Set(busyBatchIdsRef.current));
  }

  useEffect(() => {
    for (const batch of batches) {
      const execution = batch.activeExecution ?? batch.latestExecution;
      if (execution && !executionDetails[execution.id]) {
        void loadExecution(batch.id, execution.id);
      }
    }
  }, [batches, executionDetails, loadExecution]);

  async function requestRun(batch: BatchView): Promise<void> {
    if (!beginBatchAction(batch.id)) return;
    try {
      const preflight = await state.preflight(batch.id);
      if (preflight.requiresConfirmation) {
        setConfirmation({ kind: "run", batch, fileCount: preflight.selectedCount, totalBytes: preflight.totalBytes });
      } else {
        await state.runNow(batch.id);
        toast.success("Batch queued");
      }
    } catch (error) {
      toast.error("Batch could not run", { description: message(error) });
    } finally {
      endBatchAction(batch.id);
    }
  }

  async function confirm(): Promise<void> {
    if (!confirmation) return;
    const target = confirmation;
    if (!beginBatchAction(target.batch.id)) return;
    try {
      if (target.kind === "run") {
        await state.runNow(target.batch.id);
        toast.success("Batch queued");
      } else if (target.kind === "delete") {
        await state.remove(target.batch.id);
        toast.success("Batch deleted");
      } else {
        await state.clearResults(target.batch.id, target.execution.id);
        toast.success("Copied Batch results cleared");
      }
      setConfirmation(null);
    } catch (error) {
      toast.error("Batch action failed", { description: message(error) });
    } finally {
      endBatchAction(target.batch.id);
    }
  }

  async function cancel(batch: BatchView, execution: BatchExecutionSummary): Promise<void> {
    if (!beginBatchAction(batch.id)) return;
    try {
      await state.cancel(batch.id, execution.id);
      toast.success("Batch cancellation requested");
    } catch (error) {
      toast.error("Batch could not be cancelled", { description: message(error) });
    } finally {
      endBatchAction(batch.id);
    }
  }

  return (
    <>
      <OverviewPanel
        title="Batches"
        description="Folder-backed file runs admitted through the durable task queue."
        tabs={tabs}
        actions={<><Button size="sm" variant="outline" onClick={() => void state.refresh()} disabled={state.loading}><RefreshCw className={state.loading ? "size-4 animate-spin" : "size-4"} />Refresh</Button><Button size="sm" onClick={onNew}><Plus className="size-4" />New Batch</Button></>}
      >
        {state.error ? <div role="alert" className="flex items-center gap-2 text-sm text-destructive"><CircleAlert className="size-4" />{state.error}</div> : null}
        {state.loading && state.batches.length === 0 ? <div role="status" className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading Batches…</div> : null}
        {!state.loading && state.batches.length === 0 ? <PanelEmptyState className="mt-4 bg-transparent p-8"><p className="font-medium">No Batches yet</p><Button className="mt-4" size="sm" onClick={onNew}>Create Batch</Button></PanelEmptyState> : null}
        <OverviewSection title="Definitions" count={state.batches.length}>
          {state.batches.map((batch) => {
            const execution = batch.activeExecution ?? batch.latestExecution;
            const activeExecution = batch.activeExecution;
            const detail = execution ? state.executionDetails[execution.id] : undefined;
            const executionId = execution?.id;
            const isBusy = busyBatchIds.has(batch.id);
            const resultsCleared = Boolean(execution?.resultsClearedAt || detail?.execution.resultsClearedAt);
            return <OverviewRow key={batch.id} status={batch.activeExecution ? "running" : "waiting"} actions={<>
              {activeExecution ? <Button size="sm" variant="outline" aria-label={`Cancel ${batch.name}`} disabled={isBusy} onClick={() => void cancel(batch, activeExecution)}><X className="size-4" />Cancel</Button> : <Button size="sm" aria-label={`Run ${batch.name}`} disabled={isBusy} onClick={() => void requestRun(batch)}><Play className="size-4" />Run now</Button>}
              <Button size="icon-sm" variant="ghost" aria-label={`Edit ${batch.name}`} disabled={isBusy} onClick={() => onEdit(batch)}><Pencil className="size-4" /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Delete ${batch.name}`} disabled={isBusy} onClick={() => setConfirmation({ kind: "delete", batch })}><Trash2 className="size-4" /></Button>
            </>}>
              <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{batch.name}</p>{execution ? <Badge variant="outline">{formatExecutionStatus(execution.status)}</Badge> : null}{execution?.retainedResultBytes ? <span className="text-xs text-muted-foreground">{formatBytes(execution.retainedResultBytes)} retained</span> : null}</div>
              <p className="mt-1 truncate text-xs text-muted-foreground">{batch.folderPath} · {formatDisplayName(batch.workflowId)} · {batch.projectId ?? "No project"} · {batch.rerunPolicy.replaceAll("_", " ")}</p>
              {execution ? <p className="mt-1 text-xs text-muted-foreground">{formatCounts(execution)}</p> : null}
              {resultsCleared ? <p className="mt-1 text-xs text-muted-foreground">Copied result cleared</p> : null}
              {detail?.items.length && executionId ? <div className="mt-3 space-y-1 border-t border-border/50 pt-2">{detail.items.map((item) => { const sessionId = item.sessionId; return <div key={item.id} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{item.fileName}</span><Badge variant="outline">{item.status}</Badge>{sessionId && onOpenSession ? <Button size="icon-xs" variant="ghost" aria-label={`Open session for ${item.fileName}`} onClick={() => onOpenSession(sessionId)}><ExternalLink className="size-3" /></Button> : null}{item.resultArtifacts.map((artifact, index) => resultsCleared ? <span key={`${item.id}:${index}`} className="inline-flex size-6 items-center justify-center text-muted-foreground" aria-label={`Cleared ${artifact.role} result for ${item.fileName}`} title="Copied result cleared"><Download className="size-3" /></span> : <a key={`${item.id}:${index}`} className="inline-flex size-6 items-center justify-center" aria-label={`Download ${artifact.role} result for ${item.fileName}`} href={batchArtifactUrl(batch.id, executionId, item.id, index)}><Download className="size-3" /></a>)}</div>; })}{detail.nextCursor ? <Button size="sm" variant="ghost" disabled={state.loadingMoreExecutionIds?.has(executionId)} onClick={() => void state.loadMoreItems(batch.id, executionId)}>{state.loadingMoreExecutionIds?.has(executionId) ? "Loading files…" : "Load more files"}</Button> : null}</div> : null}
              {execution?.completedAt && execution.retainedResultBytes > 0 && !execution.resultsClearedAt ? <Button className="mt-2" size="sm" variant="ghost" aria-label={`Clear copied results for ${batch.name}`} onClick={() => setConfirmation({ kind: "clear", batch, execution })}>Clear copied results</Button> : null}
            </OverviewRow>;
          })}
        </OverviewSection>
      </OverviewPanel>

      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !(confirmation && busyBatchIds.has(confirmation.batch.id))) setConfirmation(null); }}>
        <DialogContent showCloseButton={!(confirmation && busyBatchIds.has(confirmation.batch.id))}>
          <DialogHeader><DialogTitle>{dialogTitle(confirmation)}</DialogTitle><DialogDescription>{dialogDescription(confirmation)}</DialogDescription></DialogHeader>
          <DialogFooter><DialogClose render={<Button variant="outline" disabled={Boolean(confirmation && busyBatchIds.has(confirmation.batch.id))} />}>Cancel</DialogClose><Button variant={confirmation?.kind === "run" ? "default" : "destructive"} disabled={Boolean(confirmation && busyBatchIds.has(confirmation.batch.id))} onClick={() => void confirm()}>{confirmation?.kind === "run" ? "Run Batch" : confirmation?.kind === "clear" ? "Clear copied results" : "Delete Batch"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function dialogTitle(value: Confirmation | null): string {
  if (!value) return "Batch action";
  if (value.kind === "run") return `Run ${value.fileCount} files?`;
  if (value.kind === "clear") return `Clear copied results for ${value.batch.name}?`;
  return `Delete ${value.batch.name}?`;
}

function dialogDescription(value: Confirmation | null): string {
  if (!value) return "";
  if (value.kind === "run") return `This preflight selected ${value.fileCount} files (${formatBytes(value.totalBytes)}). The server will rescan before admission.`;
  if (value.kind === "clear") return "Only copied Batch results are removed. Journals, rerun history, sessions, and original run artifacts stay available.";
  return "This removes the definition and its rerun history. Recreating it may repeat paid work; sessions and original artifacts remain.";
}

function formatCounts(execution: BatchExecutionSummary): string {
  const visible = Object.entries(execution.counts).filter(([, count]) => count > 0);
  return visible.length ? visible.map(([status, count]) => `${count} ${status.replaceAll("_", " ")}`).join(" · ") : "No files admitted";
}

function formatExecutionStatus(status: BatchExecutionSummary["status"]): string {
  return status === "partially_completed"
    ? "Partially completed"
    : `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
