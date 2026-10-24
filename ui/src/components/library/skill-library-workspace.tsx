import { Archive, ArchiveRestore, History, Pencil, UserPlus } from "lucide-react";
import { startTransition, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { SkillEditorDialog } from "@/components/library/skill-editor-dialog";
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
  attachResourceSkill,
  readResourceLibraryRevisionFiles,
  restoreResourceSkillRevision,
  setResourceSkillArchived,
} from "@/lib/clients/resource-library-client";
import { formatDisplayName } from "@/lib/utils/display-name";
import type {
  ResourceLibraryBrowserSnapshot,
  ResourceLibraryRevisionFile,
  ResourceLibraryRevisionFiles,
  ResourceLibrarySkillRevision,
} from "@contracts/resource-library";

export function SkillLibraryWorkspace({
  snapshot,
  skillId,
  onRefresh,
  onResourceSelect,
  onCreateActionChange,
  packageActions,
}: {
  packageActions?: ReactNode;
  onCreateActionChange?: ((action: (() => void) | null) => void) | undefined;
  snapshot: ResourceLibraryBrowserSnapshot;
  skillId: string | null;
  onRefresh: () => void;
  onResourceSelect: (skillId: string) => void;
}) {
  const skill = snapshot.skills.find((candidate) => candidate.id === skillId) ?? null;
  const revisionId = skill?.currentRevisionId ?? null;
  const [files, setFiles] = useState<ResourceLibraryRevisionFiles | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<"create" | "edit" | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [comparison, setComparison] = useState<{ revisionId: string; files: ResourceLibraryRevisionFiles } | null>(null);

  useEffect(() => {
    if (!skillId || !revisionId) return;
    let active = true;
    startTransition(() => {
      setFiles(null);
      setError(null);
      setComparison(null);
    });
    void readResourceLibraryRevisionFiles({ skillId, revisionId })
      .then((next) => {
        if (!active) return;
        setFiles(next);
        setSelectedPath(next.files.some((file) => file.path === "SKILL.md") ? "SKILL.md" : next.files[0]?.path ?? null);
      })
      .catch((nextError: unknown) => {
        if (active) setError(errorMessage(nextError));
      });
    return () => {
      active = false;
    };
  }, [skillId, revisionId]);

  const currentRevision = skill?.revisions.find((revision) => revision.id === skill.currentRevisionId);
  const usedBy = skill ? snapshot.agents.filter((agent) =>
    agent.attachments.some((attachment) => attachment.skillId === skill.id)
  ) : [];
  const availableAgents = skill ? snapshot.agentDetails.filter((agent) =>
    !snapshot.agents.find((candidate) => candidate.id === agent.name)?.attachments.some(
      (attachment) => attachment.alias === skill.slug,
    )
  ) : [];

  const perform = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      onRefresh();
    } catch (nextError) {
      setError(errorMessage(nextError));
      toast.error("Library update failed", { description: errorMessage(nextError) });
    } finally {
      setPending(false);
    }
  };

  const toggleArchive = async () => {
    if (!skill) return;
    await perform(async () => {
      const result = await setResourceSkillArchived({
        skillId: skill.id,
        archived: !skill.archived,
        expectedGeneration: snapshot.generation,
      });
      toast.success(result.skill.archived ? "Skill archived" : "Skill available again", {
        description: result.skill.archived
          ? "Unavailable for new attachments. Existing Agent attachments and revision history are kept."
          : "Available for new Agent attachments.",
      });
    });
  };

  const compare = async (revisionIdToCompare: string) => {
    if (!skill) return;
    setPending(true);
    setError(null);
    try {
      const next = await readResourceLibraryRevisionFiles({
        skillId: skill.id,
        revisionId: revisionIdToCompare,
      });
      setComparison({ revisionId: revisionIdToCompare, files: next });
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setPending(false);
    }
  };

  const openEditor = (mode: "create" | "edit") => {
    setEditorKey((current) => current + 1);
    setEditor(mode);
  };

  useEffect(() => {
    onCreateActionChange?.(() => {
      setEditorKey((current) => current + 1);
      setEditor("create");
    });
    return () => onCreateActionChange?.(null);
  }, [onCreateActionChange]);

  return (
    <div className="mx-auto w-full max-w-7xl p-6">
      {!skill ? (
        <>
          <header className="mb-5 flex items-center justify-between gap-4">
            <h2 className="font-heading text-2xl font-semibold">Skills</h2>
            <div className="flex items-center gap-2">{packageActions}</div>
          </header>
          <PanelEmptyState>Select a skill to inspect it, or use the top-left plus to create one.</PanelEmptyState>
        </>
      ) : (
        <>
          <header className="border-b border-border/70 pb-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <h2 className="truncate font-heading text-2xl font-semibold" title={skill.displayName}>{skill.displayName}</h2>
                <Badge variant="secondary">{skill.archived ? "Archived" : `Revision ${currentRevision?.sequence ?? 1}`}</Badge>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button type="button" size="sm" variant="ghost" disabled={!files || pending} onClick={() => openEditor("edit")}>
                  <Pencil aria-hidden="true" /> Edit
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={skill.archived || availableAgents.length === 0 || pending}
                    render={<Button type="button" size="sm" variant="ghost" />}
                  >
                    <UserPlus aria-hidden="true" /> Attach
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
                    {availableAgents.map((agent) => (
                      <DropdownMenuItem
                        key={agent.name}
                        onClick={() => void perform(() => attachResourceSkill({
                          agentId: agent.name,
                          skillId: skill.id,
                          revisionId: skill.currentRevisionId,
                          alias: skill.slug,
                          expectedGeneration: snapshot.generation,
                        }))}
                      >
                        <span className="min-w-0 whitespace-normal wrap-break-word">{formatDisplayName(agent.name)}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void toggleArchive()}
                >
                  {skill.archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
                  {skill.archived ? "Unarchive" : "Archive"}
                </Button>
                {packageActions}
              </div>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{skill.description || "No skill description yet."}</p>
          </header>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <InfoList title="Usage" values={usedBy.length > 0 ? usedBy.map((agent) => formatDisplayName(agent.id)) : ["Not attached to an agent"]} />
            <InfoList title="Provenance" values={skill.provenance.length > 0 ? skill.provenance : ["Created in Library"]} />
          </div>
          {error ? <p className="mt-4 text-sm text-destructive" role="alert">{error}</p> : null}
          {files ? (
            <RevisionFileBrowser files={files.files} selectedPath={selectedPath} onSelect={setSelectedPath} />
          ) : !error ? <p className="mt-6 text-sm text-muted-foreground" role="status">Loading revision files…</p> : null}
          <section className="mt-8" aria-label="Skill revision history">
            <div className="mb-2 flex items-center gap-2">
              <History className="size-4" aria-hidden="true" />
              <h3 className="font-heading text-base font-semibold">History</h3>
            </div>
            <div className="divide-y rounded-xl border border-border/70">
              {[...skill.revisions].sort((left, right) => right.sequence - left.sequence).map((revision) => (
                <div key={revision.id} aria-label={`Revision ${revision.sequence} actions`} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Revision {revision.sequence}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {revision.changeNote || "No change note"} · {revision.createdAt}
                      {revision.parentRevisionId ? ` · Parent Revision ${revision.sequence - 1}` : ""}
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="ghost" disabled={pending || revision.id === skill.currentRevisionId} onClick={() => void compare(revision.id)}>
                    Compare
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending || revision.id === skill.currentRevisionId}
                    onClick={() => void perform(() => restoreResourceSkillRevision({
                      skillId: skill.id,
                      sourceRevisionId: revision.id,
                      baseRevisionId: skill.currentRevisionId,
                      changeNote: `Restore Revision ${revision.sequence}`,
                      expectedGeneration: snapshot.generation,
                    }))}
                  >
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          </section>
          {comparison && currentRevision && files ? (
            <RevisionComparison
              currentRevision={currentRevision}
              currentFiles={files.files}
              historicalRevision={skill.revisions.find((revision) => revision.id === comparison.revisionId) ?? currentRevision}
              historicalFiles={comparison.files.files}
            />
          ) : null}
        </>
      )}
      {editor ? (
        <SkillEditorDialog
          key={`${editor}-${editorKey}`}
          open
          skill={editor === "edit" && skill ? skill : undefined}
          initialFiles={editor === "edit" && files ? files : undefined}
          expectedGeneration={snapshot.generation}
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
          onSaved={(result) => {
            if (editor === "create") onResourceSelect(result.skill.id);
            onRefresh();
          }}
        />
      ) : null}
      {pending ? <p className="sr-only" role="status">Updating Library…</p> : null}
    </div>
  );
}

function RevisionFileBrowser({
  files,
  selectedPath,
  onSelect,
}: {
  files: ResourceLibraryRevisionFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;
  return (
    <div className="mt-6 grid min-h-0 gap-4 md:grid-cols-4">
      <div className="space-y-1" aria-label="Revision files">
        <h3 className="mb-2 font-heading text-base font-semibold">Files</h3>
        {files.map((file) => (
          <Button
            key={file.path}
            type="button"
            variant="ghost"
            aria-pressed={selectedPath === file.path}
            className="h-auto w-full justify-start px-2.5 py-2 text-left font-normal aria-pressed:bg-accent"
            onClick={() => onSelect(file.path)}
          >
            <span className="truncate">{file.path}</span>
          </Button>
        ))}
      </div>
      <div className="min-w-0 md:col-span-3">
        {selectedFile ? (
          <pre className="max-h-96 overflow-auto rounded-xl border border-border/70 bg-muted/40 p-4 text-xs whitespace-pre-wrap">{decodeBase64(selectedFile.contentBase64)}</pre>
        ) : null}
      </div>
    </div>
  );
}

function RevisionComparison({
  currentRevision,
  currentFiles,
  historicalRevision,
  historicalFiles,
}: {
  currentRevision: ResourceLibrarySkillRevision;
  currentFiles: ResourceLibraryRevisionFile[];
  historicalRevision: ResourceLibrarySkillRevision;
  historicalFiles: ResourceLibraryRevisionFile[];
}) {
  const rows = useMemo(() => {
    const paths = [...new Set([...currentRevision.files.map((file) => file.path), ...historicalRevision.files.map((file) => file.path)])].sort();
    const currentManifest = new Map(currentRevision.files.map((file) => [file.path, file]));
    const historicalManifest = new Map(historicalRevision.files.map((file) => [file.path, file]));
    const currentContents = new Map(currentFiles.map((file) => [file.path, file.contentBase64]));
    const historicalContents = new Map(historicalFiles.map((file) => [file.path, file.contentBase64]));
    return paths.map((path) => {
      const current = currentManifest.get(path);
      const historical = historicalManifest.get(path);
      const status = !current ? "removed" : !historical ? "added" : current.sha256 === historical.sha256 ? "unchanged" : "modified";
      return {
        path,
        status,
        current,
        historical,
        changes: status === "modified"
          ? textChanges(decodeBase64(historicalContents.get(path) ?? ""), decodeBase64(currentContents.get(path) ?? ""))
          : [],
      };
    });
  }, [currentRevision, historicalRevision, currentFiles, historicalFiles]);

  return (
    <section className="mt-8" aria-label="Revision comparison">
      <h3 className="mb-2 font-heading text-base font-semibold">Revision {historicalRevision.sequence} → Revision {currentRevision.sequence}</h3>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.path} className="rounded-xl border border-border/70 p-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{row.path}</span>
              <Badge variant={row.status === "unchanged" ? "secondary" : "outline"}>{row.status}</Badge>
            </div>
            <div className="mt-2 grid gap-2 text-muted-foreground md:grid-cols-2">
              <span>Revision {historicalRevision.sequence}: {row.historical ? `${row.historical.sizeBytes} bytes · ${row.historical.sha256}` : "not present"}</span>
              <span>Revision {currentRevision.sequence}: {row.current ? `${row.current.sizeBytes} bytes · ${row.current.sha256}` : "not present"}</span>
            </div>
            {row.changes.length > 0 ? (
              <div className="mt-3 rounded-lg bg-muted/40 p-2 font-mono">
                {row.changes.map((change, index) => (
                  <div key={index} className={change.kind === "added" ? "text-primary-text" : "text-destructive"}>
                    {change.kind === "added" ? "+ " : "− "}{change.text || " "}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function textChanges(left: string | null, right: string | null): { kind: "added" | "removed"; text: string }[] {
  if (left === null || right === null) return [];
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  let prefix = 0;
  while (prefix < leftLines.length && prefix < rightLines.length && leftLines[prefix] === rightLines[prefix]) prefix += 1;
  let leftEnd = leftLines.length;
  let rightEnd = rightLines.length;
  while (leftEnd > prefix && rightEnd > prefix && leftLines[leftEnd - 1] === rightLines[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  return [
    ...leftLines.slice(prefix, leftEnd).map((text) => ({ kind: "removed" as const, text })),
    ...rightLines.slice(prefix, rightEnd).map((text) => ({ kind: "added" as const, text })),
  ];
}

function InfoList({ title, values }: { title: string; values: string[] }) {
  return (
    <section className="mt-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
      <ul className="space-y-1 text-sm">{values.map((value) => <li key={value} className="truncate">{value}</li>)}</ul>
    </section>
  );
}

function decodeBase64(value: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
