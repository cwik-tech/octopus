import { Bot, FolderPlus, Globe2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { FieldHelp } from "@/components/ui/field-help";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProjectContextPicker } from "@/components/run/chat/project-context-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { listAgents } from "@/lib/clients/agent-generator-client";
import { isSelectableAgent } from "@/lib/models/agent-generator-model";
import type { AgentSummary } from "@/lib/models/agent-generator-model";
import { listWorkflows } from "@/lib/clients/session-client";
import { createProject, listProjects } from "@/lib/clients/project-client";
import {
  ProjectEditorDialog,
  type ProjectEditorValue,
} from "@/components/library/project-editor-dialog";
import type {
  WorkspaceProjectContextSelection,
  WorkspaceProjectSummary,
  WorkflowSummary,
} from "@/lib/models/session-model";
import type { WorkspaceProject } from "@contracts/projects";
import { formatDisplayName } from "@/lib/utils/display-name";
import type {
  Schedule,
  ScheduleInput,
  ScheduleKind,
  ScheduleOverlapPolicy,
  ScheduleProjectContextSelection,
} from "@/lib/clients/schedules-client";
import {
  availableTimezones,
  agentTargetLabel,
  agentWebAccessLabel,
  compileSchedulePreset,
  inferSchedulePreset,
  SCHEDULE_PRESETS,
  sortAgentsByWebAccess,
  type SchedulePreset,
} from "@/components/schedule/schedule-form-model";

export function ScheduleForm({
  onCancel,
  onSave,
  schedule,
}: {
  onCancel: () => void;
  onSave: (input: ScheduleInput) => Promise<void>;
  schedule?: Schedule | undefined;
}) {
  const inferred = inferSchedulePreset(schedule?.cron ?? "0 9 * * *");
  const [name, setName] = useState(schedule?.name ?? "");
  const [kind, setKind] = useState<ScheduleKind>(schedule?.kind ?? "agent");
  const [target, setTarget] = useState(schedule?.target ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [preset, setPreset] = useState<SchedulePreset>(inferred.preset);
  const [time, setTime] = useState(inferred.time);
  const [customCron, setCustomCron] = useState(schedule?.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(
    schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [overlap, setOverlap] = useState<ScheduleOverlapPolicy>(
    schedule?.overlap ?? "skip",
  );
  const [notifyOnFailure, setNotifyOnFailure] = useState(
    schedule?.notifyOnFailure ?? false,
  );
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [projectId, setProjectId] = useState<string | undefined>(schedule?.projectId);
  const [projectContext, setProjectContext] = useState<
    ScheduleProjectContextSelection | undefined
  >(schedule?.projectContext);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [projects, setProjects] = useState<WorkspaceProjectSummary[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectDialogPending, setProjectDialogPending] = useState(false);
  const [projectDialogError, setProjectDialogError] = useState<string | null>(null);
  const timezones = useMemo(() => availableTimezones(), []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listAgents(),
      listWorkflows(),
      listProjects({ includeArchived: true }),
    ])
      .then(([nextAgents, nextWorkflows, nextProjects]) => {
        if (cancelled) return;
        setAgents(nextAgents.filter(isSelectableAgent));
        setWorkflows(nextWorkflows);
        setProjects(nextProjects);
        setResourcesError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResourcesError(
            error instanceof Error ? error.message : "Targets could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setResourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const compiled = useMemo(() => {
    try {
      return compileSchedulePreset(preset, time, customCron);
    } catch {
      return { cron: "", label: "Choose a valid time" };
    }
  }, [customCron, preset, time]);
  const selectedAgent = kind === "agent"
    ? agents.find((agent) => agent.name === target)
    : undefined;
  const selectedProject = projects.find((project) => project.id === projectId);
  const targets: Array<{
    browserEnabled?: boolean;
    label: string;
    value: string;
  }> = kind === "agent"
    ? sortAgentsByWebAccess(agents).map((agent) => ({
        browserEnabled: agent.browserEnabled,
        label: agentTargetLabel(agent),
        value: agent.name,
      }))
    : workflows.map((workflow) => ({
        value: workflow.id,
        label: formatDisplayName(workflow.id),
      }));
  const selectedTargetLabel = targets.find((option) => option.value === target)?.label;

  function changeKind(nextKind: ScheduleKind): void {
    if (nextKind === kind) return;
    setKind(nextKind);
    setTarget("");
  }

  /**
   * A schedule is often the reason the project needs to exist, so the picker
   * creates one inline rather than sending the reader to the Library and back.
   * The new project joins this form's list and becomes the selection.
   */
  async function addProject(value: ProjectEditorValue): Promise<void> {
    setProjectDialogPending(true);
    setProjectDialogError(null);
    try {
      const created = await createProject(value);
      setProjects((current) => [projectSummaryOf(created), ...current]);
      setProjectId(created.id);
      setProjectContext(undefined);
      setProjectDialogOpen(false);
    } catch (error) {
      setProjectDialogError(
        error instanceof Error ? error.message : "Project could not be created.",
      );
    } finally {
      setProjectDialogPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    if (!name.trim()) return setFormError("Give the schedule a name.");
    if (!target) return setFormError(`Choose an ${kind === "agent" ? "agent" : "workflow"}.`);
    if (!prompt.trim()) return setFormError(kind === "agent" ? "Enter an agent prompt." : "Enter a workflow brief.");
    if (!compiled.cron || compiled.cron.split(/\s+/).length !== 5) {
      return setFormError("Cron must contain exactly five fields.");
    }
    setSubmitting(true);
    try {
      await onSave({
        name: name.trim(),
        kind,
        target,
        ...(projectId ? { projectId } : {}),
        ...(projectId && projectContext ? { projectContext } : {}),
        prompt: prompt.trim(),
        cron: compiled.cron,
        timezone,
        scheduleLabel: compiled.label,
        overlap,
        notifyOnFailure,
        enabled,
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Schedule could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="flex h-full min-h-0 flex-col overflow-hidden"
      onSubmit={(event) => void submit(event)}
    >
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="grid items-start gap-x-8 gap-y-6 xl:grid-cols-2">
          <div className="space-y-6">
            <FormSection title="Job">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" htmlFor="schedule-name">
                  <Input
                    id="schedule-name"
                    value={name}
                    maxLength={120}
                    placeholder="Weekday market brief"
                    onChange={(event) => setName(event.target.value)}
                    disabled={submitting}
                  />
                </Field>

                <div>
                  <span className="mb-1.5 block text-sm font-medium">Run</span>
                  <KindSwitch kind={kind} onChange={changeKind} disabled={submitting} />
                </div>
              </div>

              <Field
                label={kind === "agent" ? "Agent" : "Workflow"}
                labelAction={kind === "agent" ? <AgentBrowserHelp /> : undefined}
              >
                {/* One provider for every globe in the picker: it owns the
                    hover delay, and its grouping makes the next row's tooltip
                    open instantly once the first one has been seen. */}
                <TooltipProvider delay={200}>
                <Select
                  key={kind}
                  value={target || null}
                  onValueChange={(value) => {
                    if (typeof value === "string") setTarget(value);
                  }}
                  disabled={resourcesLoading || submitting}
                >
                  <SelectTrigger className="w-full" aria-label={kind === "agent" ? "Agent" : "Workflow"}>
                    <SelectValue placeholder={resourcesLoading ? "Loading targets…" : `Select ${kind}`}>
                      {(selected) => {
                        if (typeof selected !== "string" || !selected) return `Select ${kind}`;
                        const label = selectedTargetLabel ?? selected;
                        if (kind !== "agent") return label;
                        return (
                          <span className="flex items-center gap-2">
                            <AgentBrowserGlobe browserEnabled={selectedAgent?.browserEnabled} />
                            {label}
                          </span>
                        );
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start" alignItemWithTrigger={false}>
                    {targets.length === 0 && !resourcesLoading ? (
                      <SelectItem value="__none__" disabled>
                        {kind === "agent" ? "No agents available" : "No workflows available"}
                      </SelectItem>
                    ) : null}
                    {targets.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {kind === "agent" ? (
                          <AgentBrowserGlobe browserEnabled={option.browserEnabled} />
                        ) : null}
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                </TooltipProvider>
                {resourcesError ? <FieldError>{resourcesError}</FieldError> : null}
              </Field>

              <Field
                label={kind === "agent" ? "Prompt" : "Run brief"}
                htmlFor="schedule-prompt"
                hint="This exact text is used for every fire."
              >
                <Textarea
                  id="schedule-prompt"
                  value={prompt}
                  maxLength={20_000}
                  rows={6}
                  placeholder={kind === "agent" ? "Describe the result the agent should produce…" : "Describe the workflow objective and constraints…"}
                  onChange={(event) => setPrompt(event.target.value)}
                  disabled={submitting}
                />
              </Field>
            </FormSection>
          </div>

          <div className="space-y-6">
            <FormSection title="Clock">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Frequency">
                  <NativeSelect
                    ariaLabel="Frequency"
                    value={preset}
                    onChange={(value) => setPreset(value as SchedulePreset)}
                    disabled={submitting}
                  >
                    {SCHEDULE_PRESETS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </NativeSelect>
                </Field>
                {preset !== "every_30_minutes" && preset !== "hourly" && preset !== "custom" ? (
                  <Field label="Time" htmlFor="schedule-time">
                    <Input
                      id="schedule-time"
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                      disabled={submitting}
                    />
                  </Field>
                ) : null}
                <Field label="Timezone">
                  <NativeSelect ariaLabel="Timezone" value={timezone} onChange={setTimezone} disabled={submitting}>
                    {timezones.map((value) => <option key={value} value={value}>{value}</option>)}
                  </NativeSelect>
                </Field>
              </div>
              {preset === "custom" ? (
                <Field label="Cron expression" htmlFor="schedule-cron" hint="Five fields: minute, hour, day, month, weekday.">
                  <Input
                    id="schedule-cron"
                    value={customCron}
                    onChange={(event) => setCustomCron(event.target.value)}
                    placeholder="0 9 * * 1-5"
                    disabled={submitting}
                  />
                </Field>
              ) : null}
            </FormSection>

            <FormSection title="Run behavior">
              <Field label="When a previous fire is still active">
                <NativeSelect
                  ariaLabel="Overlap policy"
                  value={overlap}
                  onChange={(value) => setOverlap(value as ScheduleOverlapPolicy)}
                  disabled={submitting}
                >
                  <option value="skip">Skip this fire</option>
                  <option value="queue">Queue another run</option>
                  <option value="cancel_previous">Cancel previous, then run</option>
                </NativeSelect>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <ToggleRow
                  label="Enabled"
                  description="Paused schedules remain saved but do not fire."
                  checked={enabled}
                  onChange={setEnabled}
                  disabled={submitting}
                />
                <ToggleRow
                  label="Notify on failure"
                  description="The preference is saved; notification delivery is not available yet."
                  checked={notifyOnFailure}
                  onChange={setNotifyOnFailure}
                  disabled={submitting}
                />
              </div>
            </FormSection>

            <FormSection title="Project">
              <Field
                label="Project"
                hint="Optional. Every fire creates a new session in this project."
              >
                <Select
                  value={projectId ?? "__none__"}
                  onValueChange={(value) => {
                    // "New project" is an action, not a selection: leave the
                    // current choice alone and let the dialog decide.
                    if (value === NEW_PROJECT_VALUE) {
                      setProjectDialogError(null);
                      setProjectDialogOpen(true);
                      return;
                    }
                    const next = typeof value === "string" && value !== "__none__"
                      ? value
                      : undefined;
                    setProjectId(next);
                    setProjectContext(undefined);
                  }}
                  disabled={resourcesLoading || submitting}
                >
                  <SelectTrigger className="w-full" aria-label="Project">
                    <SelectValue>
                      {(selected) => {
                        if (selected === "__none__") return "No project";
                        const project = projects.find((entry) => entry.id === selected);
                        if (!project) return "No project";
                        return project.status === "archived"
                          ? `${project.name} (Archived)`
                          : project.name;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start" alignItemWithTrigger={false}>
                    <SelectItem value="__none__">No project</SelectItem>
                    {projects.map((project) => (
                      <SelectItem
                        key={project.id}
                        value={project.id}
                        disabled={project.status === "archived"}
                      >
                        {project.name}{project.status === "archived" ? " (Archived)" : ""}
                      </SelectItem>
                    ))}
                    <SelectSeparator />
                    <SelectItem value={NEW_PROJECT_VALUE}>
                      <FolderPlus className="size-4" />
                      New project…
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <ProjectEditorDialog
                open={projectDialogOpen}
                pending={projectDialogPending}
                error={projectDialogError}
                onOpenChange={(open) => {
                  setProjectDialogOpen(open);
                  if (!open) setProjectDialogError(null);
                }}
                onSubmit={(value) => void addProject(value)}
              />
              {projectId && selectedProject?.status === "active" ? (
                <div className={`${INNER_SURFACE} p-3`}>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Choose the exact project sources copied into every admitted run.
                  </p>
                  <ProjectContextPicker
                    projectId={projectId}
                    value={toWorkspaceProjectSelection(projectId, projectContext)}
                    disabled={submitting}
                    onChange={(selection) =>
                      setProjectContext(
                        selection
                          ? {
                              version: 1,
                              includeBrief: selection.includeBrief,
                              fileNames: selection.fileNames,
                            }
                          : undefined,
                      )
                    }
                  />
                </div>
              ) : selectedProject?.status === "archived" ? (
                <p className="text-xs text-muted-foreground">
                  This project is archived. Restore it before changing its project context.
                </p>
              ) : null}
            </FormSection>
          </div>
        </div>

        {formError ? <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive" role="alert">{formError}</div> : null}
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 pt-3">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" disabled={submitting || resourcesLoading}>
          {submitting ? "Saving…" : schedule ? "Save changes" : "Create schedule"}
        </Button>
      </footer>
    </form>
  );
}

/** Sentinel for the picker row that opens the create-project dialog. */
const NEW_PROJECT_VALUE = "__new_project__";

/** A project created here has no sessions yet, by definition. */
function projectSummaryOf(project: WorkspaceProject): WorkspaceProjectSummary {
  return { ...project, sessionCount: 0, activeSessionCount: 0 };
}

function toWorkspaceProjectSelection(
  projectId: string,
  selection: ScheduleProjectContextSelection | undefined,
): WorkspaceProjectContextSelection | undefined {
  return selection
    ? {
        projectId,
        includeBrief: selection.includeBrief,
        fileNames: selection.fileNames,
      }
    : undefined;
}

/**
 * The form sits directly on the panel, so the boxes nested inside it use the
 * sunken surface to stay a step darker than the page — the same treatment the
 * schedules and batches overviews give their rows.
 */
const INNER_SURFACE = "rounded-lg border border-border/60 bg-surface-sunken";

function FormSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  children,
  hint,
  htmlFor,
  label,
  labelAction,
}: {
  children: ReactNode;
  hint?: string;
  htmlFor?: string;
  label: string;
  /** Sits beside the label — the help affordance, when the field needs one. */
  labelAction?: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1">
        <label className="block text-sm font-medium" htmlFor={htmlFor}>{label}</label>
        {labelAction}
      </div>
      {children}
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * The target kind is a binary choice, so it reads as one switch rather than two
 * competing buttons: agent on the left, workflow on the right. Both side labels
 * stay clickable so nobody has to work out which end of the track means what,
 * and the row keeps the input height beside it in the two-column grid.
 */
function KindSwitch({
  disabled,
  kind,
  onChange,
}: {
  disabled?: boolean;
  kind: ScheduleKind;
  onChange: (kind: ScheduleKind) => void;
}) {
  return (
    <div className="flex h-8 items-center gap-2.5">
      <KindSwitchLabel
        active={kind === "agent"}
        disabled={disabled}
        icon={<Bot className="size-4" />}
        label="Agent"
        onClick={() => onChange("agent")}
      />
      <Switch
        checked={kind === "workflow"}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? "workflow" : "agent")}
        aria-label="Run an entire workflow instead of a single agent"
      />
      <KindSwitchLabel
        active={kind === "workflow"}
        disabled={disabled}
        icon={<Workflow className="size-4" />}
        label="Workflow"
        onClick={() => onChange("workflow")}
      />
    </div>
  );
}

function KindSwitchLabel({
  active,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean | undefined;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex cursor-pointer items-center gap-1.5 rounded text-sm transition-colors outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}

function NativeSelect({
  ariaLabel,
  children,
  disabled,
  onChange,
  value,
}: {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
    >
      {children}
    </select>
  );
}

function ToggleRow({
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 p-3 ${INNER_SURFACE}`}>
      <div>
        <div className="text-sm font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-destructive" role="alert">{children}</p>;
}

/**
 * Explains the two globe colours once, beside the field, rather than repeating
 * a claim on every row of a 60-agent list.
 */
function AgentBrowserHelp() {
  return (
    <FieldHelp label="Help: agent browser access" contentClassName="max-w-96">
      <p>
        <span className="font-medium text-emerald-400">Green globe</span> — the agent
        declares the managed Browser tool. It can open and read web pages through the
        app&apos;s own browser, and every page it visits is recorded on the session.
      </p>
      <p className="mt-2">
        <span className="font-medium text-red-400">Red globe</span> — the agent has no
        managed Browser tool, so it cannot drive that browser. It may still reach the web
        through its own provider, unless its persona declares no tools at all, which runs
        it fully isolated.
      </p>
    </FieldHelp>
  );
}

/**
 * Green when the agent declares the managed Browser tool, red when it does not.
 *
 * The colour is a statement about that one tool. It is not a claim that the
 * agent can or cannot otherwise reach the internet — a provider CLI may carry
 * web features of its own that this list cannot see.
 */
function AgentBrowserGlobe({ browserEnabled }: { browserEnabled?: boolean | undefined }) {
  const enabled = browserEnabled === true;
  const description = agentWebAccessLabel({ browserEnabled });
  return (
    <Tooltip>
      {/* A span, not the default button: these globes sit inside listbox
          options, where a nested button would swallow the row's own click.
          `pointer-events-auto` undoes the option's blanket svg rule so the
          hover actually lands. */}
      <TooltipTrigger
        aria-label={description}
        role="img"
        render={
          <span className="pointer-events-auto inline-flex shrink-0 items-center" />
        }
      >
        <Globe2
          aria-hidden="true"
          className={enabled ? "size-4 text-emerald-500" : "size-4 text-red-500"}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{description}</TooltipContent>
    </Tooltip>
  );
}
