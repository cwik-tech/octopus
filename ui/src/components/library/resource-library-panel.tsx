import { Download, Upload } from "lucide-react";
import type { BuiltInUpdateSource } from "@contracts/builtin-update";
import { exportBuiltinUpdate } from "@/lib/clients/resource-package-client";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ResourceMigrationReview } from "@/components/library/resource-migration-review";
import { ResourcePackageImportDialog } from "@/components/library/resource-package-import-dialog";
import { ResourcePackageExportDialog } from "@/components/library/resource-package-export-dialog";
import { SkillLibraryWorkspace } from "@/components/library/skill-library-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  detachResourceSkill,
  selectResourceAgentRevision,
} from "@/lib/clients/resource-library-client";
import type { LibrarySection } from "@/hooks/use-library-workspace-controller";
import { formatDisplayName } from "@/lib/utils/display-name";
import type { ResourceLibraryBrowserSnapshot } from "@contracts/resource-library";

export function ResourceLibraryPanel({
  section,
  snapshot,
  selectedResourceId,
  onRefresh = () => undefined,
  onResourceSelect = () => undefined,
  onCreateActionChange,
}: {
  section: Exclude<LibrarySection, "projects">;
  snapshot: ResourceLibraryBrowserSnapshot;
  selectedResourceId: string | null;
  onCreateActionChange?: (action: (() => void) | null) => void;
  onRefresh?: () => void;
  onResourceSelect?: (resourceId: string) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const label = section === "skills" ? "Skill library" : section === "agents" ? "Agent library" : section === "teams" ? "Team library" : "Package library";
  useEffect(() => {
    if (section === "skills" || snapshot.migrationPending) return;
    onCreateActionChange?.(() => setImporting(true));
    return () => onCreateActionChange?.(null);
  }, [section, snapshot.migrationPending, onCreateActionChange]);
  if (snapshot.migrationPending) return <section aria-label={label} className="h-full overflow-auto"><ResourceMigrationReview report={snapshot.migrationPending} onReady={onRefresh} /></section>;
  const packageActions = <>
    <Button size="sm" variant="ghost" onClick={() => setImporting(true)}><Upload aria-hidden="true" /> Import</Button>
    <Button size="sm" variant="ghost" disabled={!selectedResourceId} onClick={() => setExporting(true)}><Download aria-hidden="true" /> Export</Button>
  </>;
  return (
    <section aria-label={label} className="canvas-glow flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {section === "skills" ? (
          <SkillLibraryWorkspace
            snapshot={snapshot}
            skillId={selectedResourceId}
            onRefresh={onRefresh}
            onResourceSelect={onResourceSelect}
            onCreateActionChange={onCreateActionChange}
            packageActions={packageActions}
          />
        ) : section === "agents" ? (
          <AgentDetails snapshot={snapshot} agentId={selectedResourceId} onRefresh={onRefresh} actions={packageActions} />
        ) : section === "teams" ? (
          <TeamDetails snapshot={snapshot} teamId={selectedResourceId} actions={packageActions} />
        ) : (
          <PackageDetails snapshot={snapshot} packageId={selectedResourceId} onRefresh={onRefresh} actions={packageActions} />
        )}
      </div>
      {importing ? <ResourcePackageImportDialog onClose={() => setImporting(false)} onImported={onRefresh} /> : null}
      {exporting && selectedResourceId ? <ResourcePackageExportDialog kind={section === "skills" ? "skill" : section === "agents" ? "agent" : section === "teams" ? "team" : "package"} id={selectedResourceId} onClose={() => setExporting(false)} /> : null}
    </section>
  );
}

function AgentDetails({
  snapshot,
  agentId,
  actions,
  onRefresh,
}: {
  snapshot: ResourceLibraryBrowserSnapshot;
  agentId: string | null;
  actions: ReactNode;
  onRefresh: () => void;
}) {
  const detail = snapshot.agentDetails.find((agent) => agent.name === agentId);
  const catalog = snapshot.agents.find((agent) => agent.id === agentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useMemo(() => catalog?.attachments.map((attachment) => {
    const skill = snapshot.skills.find((candidate) => candidate.id === attachment.skillId);
    const revision = skill?.revisions.find((candidate) => candidate.id === attachment.revisionId);
    return { attachment, skill, revision };
  }) ?? [], [catalog, snapshot.skills]);

  const perform = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      onRefresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending(false);
    }
  };

  if (!detail || !catalog) return <EmptyResource label="agent" actions={actions} />;
  return (
    <div className="mx-auto w-full max-w-7xl p-6">
      <ResourceHeader title={formatDisplayName(detail.name)} subtitle={detail.description || detail.name} actions={actions} />
      <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
        <DescriptionItem label="Agent ID" value={detail.name} />
        <DescriptionItem label="Provider / model" value={[detail.provider, detail.model].filter(Boolean).join(" / ") || "Application default"} />
      </dl>
      {error ? <p className="mt-4 text-sm text-destructive" role="alert">{error}</p> : null}
      <section className="mt-6" aria-label="Agent skill attachments">
        <h3 className="mb-2 font-heading text-base font-semibold">Exact skill attachments</h3>
        {attachments.length === 0 ? <PanelEmptyState>No skills attached.</PanelEmptyState> : (
          <div className="divide-y rounded-xl border border-border/70">
            {attachments.map(({ attachment, skill, revision }) => (
              <div key={attachment.alias} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p>{skill?.displayName ?? attachment.alias} <span className="text-muted-foreground">as {attachment.alias}</span></p>
                  <p className="text-xs text-muted-foreground">Revision {revision?.sequence ?? "?"}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {skill ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger disabled={pending} render={<Button type="button" size="sm" variant="outline" />}>
                        Select revision
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {[...skill.revisions].sort((left, right) => right.sequence - left.sequence).map((candidate) => (
                          <DropdownMenuItem
                            key={candidate.id}
                            disabled={candidate.id === attachment.revisionId}
                            onClick={() => void perform(() => selectResourceAgentRevision({
                              agentId: detail.name,
                              skillId: skill.id,
                              revisionId: candidate.id,
                              expectedGeneration: snapshot.generation,
                            }))}
                          >
                            Revision {candidate.sequence}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => void perform(() => detachResourceSkill({
                      agentId: detail.name,
                      alias: attachment.alias,
                      expectedGeneration: snapshot.generation,
                    }))}
                  >
                    Detach
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <InfoList title="Used in Teams" values={detail.usedInTeams.length > 0 ? detail.usedInTeams.map((team) => formatDisplayName(team.teamName)) : ["Not used in a Team"]} />
    </div>
  );
}

function TeamDetails({ snapshot, teamId, actions }: { snapshot: ResourceLibraryBrowserSnapshot; teamId: string | null; actions: ReactNode }) {
  const team = snapshot.teamDetails.find((candidate) => candidate.id === teamId);
  if (!team) return <EmptyResource label="team" actions={actions} />;
  return (
    <div className="mx-auto w-full max-w-7xl p-6">
      <ResourceHeader title={formatDisplayName(team.name)} subtitle={team.description || team.id} badge={`${team.agentCount} agents`} actions={actions} />
      <section className="mt-6" aria-label="Team roster">
        <h3 className="mb-2 font-heading text-base font-semibold">Agent relationships</h3>
        <div className="divide-y rounded-xl border border-border/70">
          {team.agents.map((agent) => (
            <div key={agent.name} className="px-3 py-2">
              <p className="text-sm font-medium">{formatDisplayName(agent.name)}</p>
              <p className="text-xs text-muted-foreground">{agent.name} · {agent.role}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ResourceHeader({ title, subtitle, badge, actions }: { title: string; subtitle: string; badge?: string; actions: ReactNode }) {
  return (
    <header className="border-b border-border/70 pb-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate font-heading text-2xl font-semibold" title={title}>{title}</h2>
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    </header>
  );
}

function InfoList({ title, values }: { title: string; values: string[] }) {
  return (
    <section className="mt-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
      <ul className="space-y-1 text-sm">
        {values.map((value) => <li key={value} className="truncate">{value}</li>)}
      </ul>
    </section>
  );
}

function DescriptionItem({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1">{value}</dd></div>;
}

function EmptyResource({ label, actions }: { label: string; actions: ReactNode }) {
  return <div className="mx-auto w-full max-w-7xl space-y-5 p-6"><ResourceHeader title={label === "agent" ? "Agents" : "Teams"} subtitle="" actions={actions} /><PanelEmptyState>Select a {label} to inspect it.</PanelEmptyState></div>;
}

function PackageDetails({ snapshot, packageId, onRefresh, actions }: { snapshot: ResourceLibraryBrowserSnapshot; packageId: string | null; onRefresh: () => void; actions: ReactNode }) {
  const item = snapshot.packages.find((candidate) => candidate.id === packageId);
  const [review, setReview] = useState<{ filename: string; contentBase64: string; source: BuiltInUpdateSource } | null>(null);
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const inspectUpdate = async (source: BuiltInUpdateSource) => {
    setPending(true); setError(null);
    try { const result = await exportBuiltinUpdate(source); setReview({ ...result, source }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
    <ResourceHeader title={item?.origin ?? "Packages"} subtitle={item ? `Imported ${item.installedAt} · Package version ${item.version}` : ""} actions={actions} />
    {(snapshot.builtInUpdates?.length ?? 0) > 0 ? <section className="space-y-3" aria-label="Bundled resource updates">
      <h2 className="font-heading text-xl font-semibold">Bundled updates available</h2>
      <p className="text-sm text-muted-foreground">Your edits and removed defaults are preserved. Review an update to import a separate variant or explicitly add a revision. Existing Agent attachments stay pinned.</p>
      {snapshot.builtInUpdates?.map((offer) => <div key={offer.path} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"><span>{offer.path} · App {offer.appVersion}</span>{offer.kind === 'directory' ? <Button variant="outline" size="sm" disabled={pending} aria-label={`Review update for ${offer.path}`} onClick={() => void inspectUpdate({ path: offer.path, digest: offer.digest })}>Review update</Button> : <span className="text-muted-foreground">Configuration update: manual review required</span>}</div>)}
    </section> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {!item ? <PanelEmptyState>Select an imported package to inspect its contents and receipt.</PanelEmptyState> : <section className="space-y-4">
      <p className="break-all font-mono text-xs">{item.digest}</p><h3 className="font-heading font-semibold">Resources</h3><ul className="space-y-1 text-sm">{item.resourceIds.map((id) => <li key={id}>{snapshot.skills.find((skill) => skill.id === id)?.displayName ?? id}</li>)}</ul><h3 className="font-heading font-semibold">Import receipt</h3><pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">{item.receipt}</pre>
    </section>}
    {review ? <ResourcePackageImportDialog initialSource={review} builtinUpdate={review.source} onClose={() => setReview(null)} onImported={onRefresh} /> : null}
  </div>;
}
