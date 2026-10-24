import { ArrowLeft, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { FieldHelp } from "@/components/ui/field-help";
import { Input } from "@/components/ui/input";
import { listProjects } from "@/lib/clients/project-client";
import { listWorkflows } from "@/lib/clients/session-client";
import type { WorkspaceProjectSummary, WorkflowSummary } from "@/lib/models/session-model";
import { formatDisplayName } from "@/lib/utils/display-name";
import type {
  BatchDefinitionInput,
  BatchDefinitionView,
  BatchRerunPolicy,
} from "@contracts/batches";

const INELIGIBLE_WORKFLOW_TAGS = new Set(["batch-ineligible", "scheduler-generated"]);

export function BatchForm({
  batch,
  onCancel,
  onSave,
}: {
  batch?: BatchDefinitionView | undefined;
  onCancel: () => void;
  onSave: (input: BatchDefinitionInput) => Promise<void>;
}) {
  const [name, setName] = useState(batch?.name ?? "");
  const [folderPath, setFolderPath] = useState(batch?.folderPath ?? "");
  const [workflowId, setWorkflowId] = useState(batch?.workflowId ?? "");
  const [projectId, setProjectId] = useState(batch?.projectId ?? "");
  const [extensions, setExtensions] = useState(batch?.fileExtensions.join(", ") ?? "");
  const [rerunPolicy, setRerunPolicy] = useState<BatchRerunPolicy>(
    batch?.rerunPolicy ?? "new_and_changed",
  );
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [projects, setProjects] = useState<WorkspaceProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktopPickerAvailable = typeof window.pipeline?.selectBatchFolder === "function";

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listWorkflows(), listProjects()])
      .then(([nextWorkflows, nextProjects]) => {
        if (cancelled) return;
        setWorkflows(nextWorkflows.filter(isBatchEligibleWorkflow));
        setProjects(nextProjects.filter((project) => project.status === "active"));
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Batch options could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const normalizedExtensions = useMemo(
    () => normalizeExtensions(extensions),
    [extensions],
  );

  async function chooseFolder(): Promise<void> {
    if (!window.pipeline) return;
    setError(null);
    try {
      const selection = await window.pipeline.selectBatchFolder();
      if (!selection) return;
      setFolderPath(selection.path);
    } catch (pickerError) {
      setError(pickerError instanceof Error ? pickerError.message : "Folder selection was cancelled.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Give the Batch a name.");
    if (!folderPath) return setError("Choose a source folder.");
    if (!workflowId) return setError("Choose a workflow.");
    setSubmitting(true);
    try {
      await onSave({
        name: name.trim(),
        workflowId,
        folderPath,
        fileExtensions: normalizedExtensions,
        rerunPolicy,
        ...(projectId ? { projectId } : {}),
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Batch could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/90">
      <header className="flex shrink-0 items-start gap-3 border-b border-border/60 px-5 py-4">
        <Button type="button" size="sm" variant="ghost" aria-label="Back to Batches" onClick={onCancel}>
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{batch ? "Edit Batch" : "New Batch"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Process matching files through one existing workflow.</p>
        </div>
      </header>

      <form className="min-h-0 flex-1 overflow-y-auto" onSubmit={(event) => void submit(event)}>
        <div className="mx-auto max-w-3xl space-y-6 p-5">
          <FormSection title="Source">
            <Field label="Name" htmlFor="batch-name">
              <Input id="batch-name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} disabled={submitting} />
            </Field>
            <Field label="Folder" htmlFor="batch-folder" hint={desktopPickerAvailable ? "The app grants access only to the selected folder." : "The desktop app is required to select a Batch folder."}>
              <div className="flex gap-2">
                <Input id="batch-folder" value={folderPath} readOnly className="font-mono text-xs" />
                <Button type="button" variant="outline" onClick={() => void chooseFolder()} disabled={!desktopPickerAvailable || submitting}>
                  <FolderOpen className="size-4" />
                  Choose folder
                </Button>
              </div>
            </Field>
            <Field
              label="Extensions"
              labelAccessory={
                <FieldHelp label="Help: file extensions">
                  Choose which files become Batch items. Enter one or more extensions separated by commas or spaces, such as pdf, docx, or xlsx. The leading dot is optional and matching is case-insensitive. Leave blank to include every eligible file. Only top-level files are scanned; nested folders, hidden files, symlinks, and _manifest.json are ignored.
                </FieldHelp>
              }
              htmlFor="batch-extensions"
              hint="Comma or space separated, for example PDF, .docx."
            >
              <Input id="batch-extensions" value={extensions} onChange={(event) => setExtensions(event.target.value)} disabled={submitting} />
            </Field>
          </FormSection>

          <FormSection title="Execution">
            <Field label="Workflow" htmlFor="batch-workflow">
              <select id="batch-workflow" aria-label="Workflow" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} disabled={loading || submitting} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm">
                <option value="">{loading ? "Loading workflows…" : "Select workflow"}</option>
                {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{formatDisplayName(workflow.id)}</option>)}
              </select>
            </Field>
            <Field label="Project" htmlFor="batch-project" hint="Optional. Every created session is assigned to this active project.">
              <select id="batch-project" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={loading || submitting} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm">
                <option value="">No project</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </Field>
            <Field label="Rerun policy" labelAccessory={
              <FieldHelp label="Help: rerun policy" contentClassName="max-w-96 space-y-1.5">
                <p>Controls which files are processed when you run this Batch again.</p>
                <p><span className="font-medium">New files only</span> skips filenames that completed successfully before, even if their contents changed.</p>
                <p><span className="font-medium">New and changed files</span> processes new filenames and files whose contents changed.</p>
                <p><span className="font-medium">Every matching file</span> processes all eligible files on every run.</p>
                <p>Failed or cancelled files are tried again, and renaming a file makes it new.</p>
              </FieldHelp>
            } htmlFor="batch-rerun">
              <select id="batch-rerun" value={rerunPolicy} onChange={(event) => setRerunPolicy(event.target.value as BatchRerunPolicy)} disabled={submitting} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm">
                <option value="new_only">New files only</option>
                <option value="new_and_changed">New and changed files</option>
                <option value="always">Every matching file</option>
              </select>
            </Field>
          </FormSection>

          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>Cancel</Button>
            <Button type="submit" disabled={submitting}>{batch ? "Save changes" : "Create Batch"}</Button>
          </div>
        </div>
      </form>
    </section>
  );
}

function isBatchEligibleWorkflow(workflow: WorkflowSummary): boolean {
  return !(workflow.tags ?? []).some((tag) => INELIGIBLE_WORKFLOW_TAGS.has(tag));
}

function normalizeExtensions(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const lower = part.toLowerCase();
    return lower.startsWith(".") ? lower : `.${lower}`;
  }))];
}

function FormSection({ children, title }: { children: ReactNode; title: string }) {
  return <section className="space-y-4 rounded-xl border border-border/60 bg-background/35 p-4"><h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</h2>{children}</section>;
}

function Field({ children, hint, htmlFor, label, labelAccessory }: { children: ReactNode; hint?: string; htmlFor?: string; label: string; labelAccessory?: ReactNode }) {
  return <div><div className="mb-1.5 flex items-center gap-1"><label className="text-sm font-medium" htmlFor={htmlFor}>{label}</label>{labelAccessory}</div>{children}{hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}</div>;
}
