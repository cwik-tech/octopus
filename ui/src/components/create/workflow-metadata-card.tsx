import { Check, FileText, Loader2, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelCard, PanelContent, PanelHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { WorkflowDraft } from "@/lib/models/workflow-generator-model";
import { formatDisplayName } from "@/lib/utils/display-name";

interface WorkflowMetadataCardProps {
  draft?: WorkflowDraft | null;
  yaml: string | null;
  onMetadataSave: (yaml: string) => Promise<void>;
}

interface WorkflowMetadata {
  id: string;
  description: string;
}

function WorkflowMetadataCard({
  draft,
  yaml,
  onMetadataSave,
}: WorkflowMetadataCardProps) {
  if (!yaml) {
    return (
      <PanelCard className="h-full">
        <PanelHeader
          icon={<FileText className="size-4 text-muted-foreground" />}
          title="Workflow Details"
        />
        <PanelContent className="p-3">
          <div className="flex h-16 w-full items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/30 px-4 text-center text-sm text-muted-foreground">
            No workflow loaded.
          </div>
        </PanelContent>
      </PanelCard>
    );
  }

  const metadata = extractWorkflowMetadata(yaml);
  const saveMetadata = async (patch: Partial<WorkflowMetadata>) => {
    await onMetadataSave(updateWorkflowMetadata(yaml, patch));
  };

  return (
    <WorkflowMetadataEditor
      draft={draft}
      metadata={metadata}
      disabled={false}
      onSaveMetadata={saveMetadata}
    />
  );
}

function WorkflowMetadataEditor({
  draft,
  metadata,
  disabled,
  onSaveMetadata,
}: {
  draft?: WorkflowDraft | null | undefined;
  metadata: WorkflowMetadata;
  disabled: boolean;
  onSaveMetadata: (patch: Partial<WorkflowMetadata>) => Promise<void>;
}) {
  return (
    <PanelCard className="h-full">
      <PanelHeader
        icon={<FileText className="size-4 text-muted-foreground" />}
        title="Workflow Details"
      />
      <PanelContent className="flex flex-col gap-3 p-3">
        <WorkflowNameField
          key={metadata.id}
          value={metadata.id}
          disabled={disabled}
          onSave={(id) => onSaveMetadata({ id })}
        />
        <WorkflowDescriptionField
          key={metadata.description}
          value={metadata.description}
          disabled={disabled}
          onSave={(description) => onSaveMetadata({ description })}
        />
        {draft ? <WorkflowSummary draft={draft} /> : null}
      </PanelContent>
    </PanelCard>
  );
}

function WorkflowNameField({
  disabled,
  onSave,
  value,
}: {
  disabled: boolean;
  onSave: (value: string) => Promise<void>;
  value: string;
}) {
  const [nameDraft, setNameDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = nameDraft !== value;

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(nameDraft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex h-7 items-center justify-between gap-2">
        <label
          htmlFor="workflow-metadata-name"
          className="text-xs font-medium text-muted-foreground"
        >
          Name
        </label>
        {dirty ? (
          <FieldActions
            applyLabel="Save workflow name"
            cancelLabel="Discard workflow name changes"
            applyDisabled={disabled || saving || nameDraft.trim() === ""}
            saving={saving}
            onApply={() => void apply()}
            onCancel={() => {
              setError(null);
              setNameDraft(value);
            }}
          />
        ) : null}
      </div>
      <Input
        id="workflow-metadata-name"
        value={nameDraft}
        onChange={(event) => setNameDraft(event.target.value)}
        disabled={disabled || saving}
        placeholder="workflow-name"
        className="h-8 text-sm"
      />
      {error ? (
        <div className="text-xs text-destructive">{error}</div>
      ) : null}
    </div>
  );
}

function WorkflowSummary({ draft }: { draft: WorkflowDraft }) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      <SummaryItem label="Output" value={formatArtifactTitle(draft.output.artifact)} />
      <SummaryItem
        label="Failure policy"
        value={`Blocked: ${formatTitle(draft.on_blocked)}; Failed: ${formatTitle(
          draft.on_failed,
        )}`}
      />
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm text-foreground">{value}</div>
    </div>
  );
}

function formatTitle(value: string): string {
  return formatDisplayName(value);
}

function formatArtifactTitle(value: string): string {
  const filename = value.split("/").pop() ?? value;
  return formatTitle(filename.replace(/\.[^.]+$/, ""));
}

function WorkflowDescriptionField({
  disabled,
  onSave,
  value,
}: {
  disabled: boolean;
  onSave: (value: string) => Promise<void>;
  value: string;
}) {
  const [descriptionDraft, setDescriptionDraft] = useState(
    value,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = descriptionDraft !== value;

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(descriptionDraft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex h-7 items-center justify-between gap-2">
        <label
          htmlFor="workflow-metadata-description"
          className="text-xs font-medium text-muted-foreground"
        >
          Description
        </label>
        {dirty ? (
          <FieldActions
            applyLabel="Save workflow description"
            cancelLabel="Discard workflow description changes"
            applyDisabled={disabled || saving}
            saving={saving}
            onApply={() => void apply()}
            onCancel={() => {
              setError(null);
              setDescriptionDraft(value);
            }}
          />
        ) : null}
      </div>
      <Textarea
        id="workflow-metadata-description"
        value={descriptionDraft}
        onChange={(event) => setDescriptionDraft(event.target.value)}
        disabled={disabled || saving}
        placeholder="Describe when this workflow should be used."
        className="min-h-20 resize-none text-sm leading-relaxed"
      />
      {error ? (
        <div className="text-xs text-destructive">{error}</div>
      ) : null}
    </div>
  );
}

function FieldActions({
  applyDisabled,
  applyLabel,
  cancelLabel,
  onApply,
  onCancel,
  saving,
}: {
  applyDisabled?: boolean;
  applyLabel: string;
  cancelLabel: string;
  onApply: () => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={applyDisabled}
        title={applyLabel}
        aria-label={applyLabel}
        onClick={onApply}
      >
        {saving ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <Check className="size-3.5 text-emerald-700" />
        )}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        title={cancelLabel}
        aria-label={cancelLabel}
        onClick={onCancel}
      >
        <X className="size-3.5 text-muted-foreground" />
      </Button>
    </div>
  );
}

function extractWorkflowMetadata(yaml: string | null): WorkflowMetadata {
  if (!yaml) return { id: "", description: "" };

  const lines = yaml.split("\n");
  return {
    id: extractWorkflowScalar(lines, "id"),
    description: extractWorkflowScalar(lines, "description"),
  };
}

function extractWorkflowScalar(lines: string[], key: string): string {
  const index = lines.findIndex((line) =>
    new RegExp(`^  ${escapeRegExp(key)}:\\s*`).test(line),
  );
  const propertyLine = lines[index];
  if (index < 0 || propertyLine === undefined) return "";

  const rawValue = propertyLine.replace(
    new RegExp(`^  ${escapeRegExp(key)}:\\s*`),
    "",
  );
  const value = rawValue.trim();
  if (value === ">" || value === ">-") {
    const block = collectIndentedBlock(lines, index + 1);
    return block
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
  }
  if (value === "|" || value === "|-") {
    return collectIndentedBlock(lines, index + 1)
      .map((line) => line.replace(/^ {4}/, ""))
      .join("\n");
  }
  return unquoteYamlScalar(value);
}

function collectIndentedBlock(lines: string[], start: number): string[] {
  const block: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() !== "" && !/^ {4,}/.test(line)) break;
    block.push(line);
  }
  return block;
}

function updateWorkflowMetadata(
  yaml: string,
  patch: Partial<WorkflowMetadata>,
): string {
  let lines = yaml.split("\n");
  if (patch.id !== undefined) {
    lines = replaceWorkflowProperty(lines, "id", [
      `  id: ${quoteYamlScalar(patch.id.trim())}`,
    ]);
  }
  if (patch.description !== undefined) {
    lines = replaceWorkflowProperty(
      lines,
      "description",
      emitDescriptionProperty(patch.description),
    );
  }
  return lines.join("\n");
}

function replaceWorkflowProperty(
  lines: string[],
  key: string,
  replacement: string[],
): string[] {
  const propertyIndex = lines.findIndex((line) =>
    new RegExp(`^  ${escapeRegExp(key)}:\\s*`).test(line),
  );
  const propertyLine = lines[propertyIndex];
  if (propertyIndex >= 0 && propertyLine !== undefined) {
    const endIndex = findPropertyEnd(lines, propertyIndex, propertyLine);
    return [
      ...lines.slice(0, propertyIndex),
      ...replacement,
      ...lines.slice(endIndex),
    ];
  }

  const workflowIndex = lines.findIndex((line) => /^workflow:\s*$/.test(line));
  if (workflowIndex < 0) return lines;

  const insertIndex =
    key === "description"
      ? Math.max(
          workflowIndex + 1,
          findWorkflowPropertyIndex(lines, "id") + 1,
        )
      : workflowIndex + 1;

  return [
    ...lines.slice(0, insertIndex),
    ...replacement,
    ...lines.slice(insertIndex),
  ];
}

function findWorkflowPropertyIndex(lines: string[], key: string): number {
  return lines.findIndex((line) =>
    new RegExp(`^  ${escapeRegExp(key)}:\\s*`).test(line),
  );
}

function findPropertyEnd(
  lines: string[],
  start: number,
  header: string,
): number {
  const value = header.replace(/^ {2}[^:]+:\s*/, "").trim();
  if (value !== ">" && value !== ">-" && value !== "|" && value !== "|-") {
    return start + 1;
  }

  let end = start + 1;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^ {4,}/.test(line)) break;
    end++;
  }
  return end;
}

function emitDescriptionProperty(value: string): string[] {
  const text = value.trim();
  if (!text) return ["  description: ''"];
  if (!text.includes("\n") && text.length < 96) {
    return [`  description: ${quoteYamlScalar(text)}`];
  }

  return [
    "  description: >",
    ...wrapWords(text.replace(/\s+/g, " "), 76).map((line) => `    ${line}`),
  ];
}

function wrapWords(text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function quoteYamlScalar(value: string): string {
  if (!value) return "''";
  if (
    /^(true|false|null|yes|no|on|off)$/i.test(value) ||
    /^-?\d+(\.\d+)?$/.test(value) ||
    /^[\s]/.test(value) ||
    /[\s]$/.test(value) ||
    /[:#&*!|>'"%@`{}[\],]/.test(value)
  ) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

function unquoteYamlScalar(value: string): string {
  if (
    value.length >= 2 &&
    value.startsWith("'") &&
    value.endsWith("'")
  ) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (
    value.length >= 2 &&
    value.startsWith('"') &&
    value.endsWith('"')
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default WorkflowMetadataCard;
