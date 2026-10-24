import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { BuiltInUpdateSource } from "@contracts/builtin-update";
import type { ResourcePackagePreview, ResourcePackageResolution } from '@contracts/resource-package';
import { previewResourcePackage, importResourcePackage } from '@/lib/clients/resource-package-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const resolutionLabels: Record<ResourcePackageResolution['mode'], string> = {
  fork: 'Keep a separate variant',
  revision: 'Add a revision to the existing skill',
  reuse: 'Use the current local revision instead',
};

export function ResourcePackageImportDialog({ onClose, onImported, initialSource, builtinUpdate }: { onClose: () => void; onImported: () => void; initialSource?: { contentBase64: string; filename: string }; builtinUpdate?: BuiltInUpdateSource }) {
  const [source, setSource] = useState<{ contentBase64: string; filename: string } | null>(initialSource ?? null);
  const [preview, setPreview] = useState<ResourcePackagePreview | null>(null);
  const [resolutions, setResolutions] = useState<ResourcePackageResolution[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(Boolean(initialSource));
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!initialSource) return;
    const controller = new AbortController(); request.current = controller;
    void previewResourcePackage(initialSource, controller.signal).then((next) => { if (!controller.signal.aborted) setPreview(next); }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [initialSource]);
  const close = () => { request.current?.abort(); onClose(); };
  const load = async (file: File) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setPreview(null); setSource(null); setResolutions([]); setError(null); setPending(true);
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error('ZIP files must be 64 MiB or smaller.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      controller.signal.throwIfAborted();
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      const input = { contentBase64: btoa(binary), filename: file.name };
      const next = await previewResourcePackage(input, controller.signal);
      controller.signal.throwIfAborted(); setSource(input); setPreview(next);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!controller.signal.aborted) setPending(false); }
  };
  const commit = async () => {
    if (!source || !preview) return;
    const controller = new AbortController(); request.current = controller; setPending(true); setError(null);
    try {
      const result = await importResourcePackage({ ...source, digest: preview.digest, expectedGeneration: preview.expectedGeneration, resolutions, runtimeTargets: { agents: preview.agents, teams: preview.teams }, ...(builtinUpdate ? { builtinUpdate } : {}) }, controller.signal);
      toast.success(result.unchanged ? 'Package already imported' : 'Resources imported'); onImported(); onClose();
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!controller.signal.aborted) setPending(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader><DialogTitle>Import resources</DialogTitle><DialogDescription>Choose a skill or Octopus ZIP. Review its contents before anything is installed.</DialogDescription></DialogHeader>
      <Input aria-label="ZIP file" disabled={pending || Boolean(builtinUpdate)} type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void load(file); }} />
      <div className="max-h-[50vh] space-y-4 overflow-y-auto">
        {preview?.alreadyImported ? <p className="text-sm text-muted-foreground">This exact archive is already imported. Its existing receipt is reused; no resources or attachments will change.</p> : null}
        {preview?.skills.map((skill) => <div key={skill.sourceId} className="space-y-2 rounded-lg border p-3">
          <p className="font-medium">{skill.slug} · {skill.revisionCount} {skill.revisionCount === 1 ? 'revision' : 'revisions'}</p>
          <p className="text-sm text-muted-foreground">{skill.conflict === 'identical' ? 'Matching content is already installed and will be reused.' : skill.conflict === 'new' ? 'New skill.' : 'A skill with this name or identity already exists. A separate variant is kept by default.'}</p>
          {!preview?.alreadyImported && (skill.conflict === 'name' || skill.conflict === 'identity') ? <Select items={resolutionLabels} value={resolutions.find((item) => item.sourceId === skill.sourceId)?.mode ?? 'fork'} onValueChange={(mode) => {
            if (mode !== 'fork' && mode !== 'revision' && mode !== 'reuse') return;
            const target = skill.existingSkills[0];
            setResolutions((current) => [...current.filter((item) => item.sourceId !== skill.sourceId), { sourceId: skill.sourceId, mode, ...(target ? { targetSkillId: target.id, revisionId: target.revisionId } : {}) }]);
          }}><SelectTrigger className="w-full" aria-label={`Conflict resolution for ${skill.slug}`}><SelectValue /></SelectTrigger><SelectContent alignItemWithTrigger={false} className="max-w-[calc(100vw-4rem)]">{Object.entries(resolutionLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select> : null}
          {(resolutions.find((item) => item.sourceId === skill.sourceId)?.mode === 'revision' || resolutions.find((item) => item.sourceId === skill.sourceId)?.mode === 'reuse') ? <Select items={Object.fromEntries(skill.existingSkills.map((item) => [item.id, `${item.label} · ${item.id.slice(-8)}`]))} value={resolutions.find((item) => item.sourceId === skill.sourceId)?.targetSkillId ?? ''} onValueChange={(id) => {
            const target = skill.existingSkills.find((item) => item.id === id); if (!target) return;
            setResolutions((current) => current.map((item) => item.sourceId === skill.sourceId ? { ...item, targetSkillId: target.id, revisionId: target.revisionId } : item));
          }}><SelectTrigger className="w-full" aria-label={`Existing skill for ${skill.slug}`}><SelectValue /></SelectTrigger><SelectContent alignItemWithTrigger={false} className="max-w-[calc(100vw-4rem)]">{skill.existingSkills.map((item) => <SelectItem key={item.id} value={item.id}>{item.label} · {item.id.slice(-8)}</SelectItem>)}</SelectContent></Select> : null}
          {resolutions.find((item) => item.sourceId === skill.sourceId)?.mode === 'reuse' ? <p className="text-sm text-muted-foreground">Imported Agents will use your local bytes. This substitution is recorded in the import receipt.</p> : null}
        </div>)}
        {preview?.agents.map((item) => <p key={item.id}>Agent: {item.id}{item.id !== item.targetId ? ` → ${item.targetId}` : ''}</p>)}
        {preview?.teams.map((item) => <p key={item.id}>Team: {item.id}{item.id !== item.targetId ? ` → ${item.targetId}` : ''}</p>)}
        {preview?.warnings.map((warning) => <p className="text-sm text-muted-foreground" key={warning}>{warning}</p>)}
      </div>
      {error ? <p role="alert" className="max-h-24 overflow-auto text-sm text-destructive">{error}</p> : null}
      <DialogFooter><Button variant="outline" onClick={close}>Cancel</Button><Button disabled={pending || !preview} onClick={() => void commit()}>{pending ? 'Processing…' : 'Import resources'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
