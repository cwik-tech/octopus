import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ResourcePackageExport } from '@contracts/resource-package';
import { exportResourcePackage } from '@/lib/clients/resource-package-client';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const formatLabels: Record<ResourcePackageExport['format'], string> = {
  skill: 'Standard skill ZIP',
  octopus: 'Octopus package',
};

export function ResourcePackageExportDialog({ kind, id, onClose }: { kind: ResourcePackageExport['kind']; id: string; onClose: () => void }) {
  const [format, setFormat] = useState<ResourcePackageExport['format']>(kind === 'skill' ? 'skill' : 'octopus');
  const [includeHistory, setIncludeHistory] = useState(false);
  const historyId = useId();
  const historyAvailable = format === 'octopus';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const close = () => { request.current?.abort(); onClose(); };
  const download = async () => {
    const controller = new AbortController(); request.current = controller; setPending(true); setError(null);
    try {
      const result = await exportResourcePackage({ kind, id, format, includeHistory: historyAvailable && includeHistory }, controller.signal);
      const link = document.createElement('a');
      link.href = `data:application/zip;base64,${result.contentBase64}`; link.download = result.filename;
      document.body.append(link); link.click(); link.remove();
      toast.success('ZIP export ready', { description: result.filename }); onClose();
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!controller.signal.aborted) setPending(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}><DialogContent className="sm:max-w-xl">
    <DialogHeader><DialogTitle>Export resources</DialogTitle><DialogDescription>Export the selected resources and supporting files. Credentials, sessions and Agent memory are excluded.</DialogDescription></DialogHeader>
    <div className="flex items-center gap-4">
      <Select items={formatLabels} disabled={pending} value={format} onValueChange={(value) => { if (value === 'skill' || value === 'octopus') setFormat(value); }}>
        <SelectTrigger aria-label="ZIP format" className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {kind === 'skill' ? <SelectItem value="skill">{formatLabels.skill}</SelectItem> : null}
          <SelectItem value="octopus">{formatLabels.octopus}</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex shrink-0 items-center gap-2">
        <label htmlFor={historyId} className="text-sm font-medium">Include history</label>
        <Switch id={historyId} className="data-disabled:cursor-not-allowed data-disabled:opacity-50" checked={historyAvailable && includeHistory} disabled={pending || !historyAvailable} onCheckedChange={setIncludeHistory} />
      </div>
    </div>
    {format === 'skill' ? <p className="text-sm text-muted-foreground">Standard skill ZIP: the selected revision only. Octopus identity, history and Agent bindings are not included.</p> : null}
    {kind === 'package' ? <p className="text-sm text-muted-foreground">Exports the collection as accepted during import, independent of later edits or deletion of its live resources.</p> : null}
    <p className="text-sm text-muted-foreground">Required tools, services and local dependencies need separate setup.</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <DialogFooter><Button variant="outline" onClick={close}>Cancel</Button><Button disabled={pending} onClick={() => void download()}>{pending ? 'Preparing ZIP…' : 'Download ZIP'}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
