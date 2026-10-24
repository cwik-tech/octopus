import { startTransition, useEffect, useState } from "react";

import { PanelEmptyState } from "@/components/ui/card";
import { SidebarItemButton } from "@/components/sidebar/sidebar-item-button";
import { Skeleton } from "@/components/ui/skeleton";
import WorkflowPreviewSheet from "@/components/workflow/workflow-preview-sheet";
import {
  fetchGeneratorRegistry,
  validateWorkflowYaml,
} from "@/lib/clients/workflow-generator-client";
import {
  getWorkflowYaml,
  listWorkflows as apiListWorkflows,
} from "@/lib/clients/session-client";
import type { WorkflowSummary } from "@/lib/models/session-model";
import type {
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from "@/lib/models/workflow-generator-model";
import { formatDisplayName } from "@/lib/utils/display-name";

interface WorkflowPickerProps {
  selectedWorkflow: string | null;
  onSelectWorkflow: (id: string) => void;
}

function WorkflowPicker({
  selectedWorkflow,
  onSelectWorkflow,
}: WorkflowPickerProps) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewDraft, setPreviewDraft] = useState<WorkflowDraft | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<WorkflowGeneratorRegistry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    startTransition(() => {
      setLoading(true);
      setError(null);
    });
    void apiListWorkflows()
      .then((next) => {
        if (cancelled) return;
        startTransition(() => {
          setWorkflows(next);
          setLoading(false);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        startTransition(() => {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchGeneratorRegistry()
      .then((next) => {
        if (!cancelled) setRegistry(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setRegistryError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePreviewWorkflow = async (workflowId: string) => {
    setPreviewOpen(true);
    setPreviewDraft(null);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const yaml = await getWorkflowYaml(workflowId);
      const result = await validateWorkflowYaml({ yaml });
      setPreviewDraft(result.draft);
      setPreviewError(result.errors[0] ?? null);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-1.5">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
        Failed to load workflows: {error}
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <PanelEmptyState className="text-sm text-muted-foreground">
        No workflows registered yet.
      </PanelEmptyState>
    );
  }

  return (
    <>
      <ul className="space-y-1">
        {workflows.map((workflow) => (
          <li key={workflow.id}>
            <SidebarItemButton
              label={formatDisplayName(workflow.id)}
              descriptionTooltip={workflow.description || "No description."}
              previewLabel={`Preview workflow ${formatDisplayName(workflow.id)}`}
              selected={workflow.id === selectedWorkflow}
              onClick={() => onSelectWorkflow(workflow.id)}
              onPreview={() => void handlePreviewWorkflow(workflow.id)}
            />
          </li>
        ))}
      </ul>
      <WorkflowPreviewSheet
        draft={previewDraft}
        loading={previewLoading}
        open={previewOpen}
        previewError={previewError}
        registry={registry}
        registryError={registryError}
        onOpenChange={setPreviewOpen}
      />
    </>
  );
}

export default WorkflowPicker;
