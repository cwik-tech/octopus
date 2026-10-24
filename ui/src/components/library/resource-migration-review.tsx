import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ResourceMigrationReport } from '@contracts/resource-migration';
import { resourceMigrationApprovalResultSchema } from '@contracts/resource-migration';
import { Button } from '@/components/ui/button';
import { getApiBaseUrl } from '@/lib/utils/desktop';

export function ResourceMigrationReview({ report, onReady }: { report: ResourceMigrationReport; onReady: () => void }) {
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const enable = async () => {
    const controller = new AbortController(); request.current = controller;
    setPending(true); setError(null);
    try {
      const response = await fetch(`${getApiBaseUrl()}/resource-library/migration/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inventoryDigest: report.inventoryDigest, expectedGeneration: report.expectedGeneration }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Library could not be enabled.');
      const result = resourceMigrationApprovalResultSchema.parse(payload);
      toast.success('Library enabled', { description: `Original files are retained. Backup: ${result.backupPath}` }); onReady();
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!controller.signal.aborted) setPending(false); }
  };
  const variants = new Set(report.sources.map((source) => `${source.slug}:${source.digest}`)).size;
  return <div className="mx-auto max-w-3xl space-y-4 p-6">
    <h2 className="font-heading text-2xl font-semibold">Review existing resources</h2>
    <p className="text-sm text-muted-foreground">Library will retain complete copies of your existing skills and exact Agent attachments. Original folders stay in place. A verified local backup is created before Library is enabled.</p>
    <p>{report.sources.length} skill folders · {variants} distinct variants · {report.agentIds.length} Agents</p>
    <ul className="max-h-80 space-y-1 overflow-auto rounded-lg border p-3 text-sm">{report.sources.map((source) => <li key={source.path}>{source.path} · {source.files.length} files</li>)}</ul>
    <p className="text-sm text-muted-foreground">Run and Create continue to work before you enable Library. This action does not delete or rename their resources.</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <Button disabled={pending} onClick={() => void enable()}>{pending ? 'Backing up and enabling…' : 'Back up and enable Library'}</Button>
  </div>;
}
