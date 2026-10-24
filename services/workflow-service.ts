import type { ModelSelectionRecord } from "../contracts/agent-model-selection.js";
import { whenDefined } from "../core/optional-properties.js"
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  generatorSaveRequestSchema,
  generatorTurnRequestSchema,
  generatorValidateYamlRequestSchema,
  workflowUpdateRequestSchema,
} from "../contracts/schemas/builder-requests.js";
import type {
  WorkflowStageInfo,
  WorkflowSummaryWithTags,
} from "../contracts/workflows.js";
import type { AvailableWorkflow } from "../domains/sessions/chat-llm.js";
import { isGeneratedTarget } from "./generated-target-registry.js";
import {
  buildWorkflowMermaid,
  buildWorkflowYaml,
  deleteWorkflow,
  loadRegistry as loadWorkflowGeneratorRegistry,
  parseWorkflowYaml,
  runGeneratorTurn,
  saveWorkflow,
  saveWorkflowYaml,
  updateExistingWorkflowYaml,
  validateDraft,
  WorkflowDeleteNotFoundError,
} from "../domains/workflow-generator/index.js";
import type {
  ChatTurn,
  WorkflowDraft,
} from "../domains/workflow-generator/index.js";
import { WorkflowWriteConflictError } from "../domains/workflow-generator/save-workflow.js";
import {
  parseWorkflowRegistry,
  parseWorkflowTemplate,
} from "../workflows/loader.js";
import type { WorkflowStep, WorkflowTemplate } from "../workflows/types.js";
import { parseServiceRequest, ServiceError } from "./service-errors.js";

export type { WorkflowStageInfo, WorkflowSummaryWithTags };

export interface WorkflowServiceOptions {
  repoRootPath?: string;
  workflowsRegistryPath?: string;
}

export function listWorkflowEntries(
  registryPath: string | undefined,
  options?: { includeInternal?: boolean },
): WorkflowSummaryWithTags[] {
  if (!registryPath) return [];
  try {
    const result = parseWorkflowRegistry(registryPath);
    return result.entries
      .filter(
        (entry) =>
          options?.includeInternal === true || !isGeneratedTarget(entry.tags),
      )
      .map((entry) => ({
        id: entry.name,
        ...whenDefined(entry.description, (description) => ({ description })),
        ...whenDefined(entry.tags, (tags) => ({ tags })),
        ...whenDefined(entry.capabilities, (capabilities) => ({ capabilities })),
      }));
  } catch {
    return [];
  }
}

export function loadWorkflowSummaries(
  registryPath: string | undefined,
): AvailableWorkflow[] {
  if (!registryPath) return [];
  try {
    const result = parseWorkflowRegistry(registryPath);
    return result.entries.map((entry) => {
      try {
        const parsed = parseWorkflowTemplate(entry.template_path);
        if (parsed.template) {
          return summarizeWorkflowForChat(
            entry.name,
            entry.description,
            parsed.template,
          );
        }
      } catch {
        // Keep the receptionist usable when one workflow template is malformed.
      }
      return {
        id: entry.name,
        ...whenDefined(entry.description, (description) => ({ description })),
      };
    });
  } catch {
    return [];
  }
}

function projectWorkflowStages(
  template: WorkflowTemplate,
): WorkflowStageInfo[] {
  return template.steps.map((step) => {
    const discussions = Object.entries(
      step.runtime_overrides?.levels ?? {},
    ).flatMap(([levelId, override]) => {
      const discussion = override.discussion;
      if (!discussion) return [];
      return [
        {
          levelId,
          ...whenDefined(discussion.participants, (participants) => ({ participants })),
          ...whenDefined(discussion.min_rounds, (minRounds) => ({ minRounds })),
          ...whenDefined(discussion.max_rounds, (maxRounds) => ({ maxRounds })),
        },
      ];
    });
    return {
      id: step.id,
      ...whenDefined(step.team, (team) => ({ team })),
      inputArtifact: step.input_artifact,
      resultArtifact: step.result_artifact,
      ...(discussions.length ? { discussions } : {}),
    };
  });
}

export async function readWorkflowYaml(params: {
  registryPath?: string;
  workflowId: string;
}): Promise<{ yaml: string; stages: WorkflowStageInfo[] }> {
  if (!params.registryPath) {
    throw new ServiceError(
      "not_configured",
      "Workflow registry not configured",
    );
  }
  const registry = parseWorkflowRegistry(params.registryPath);
  const entry = registry.entries.find(
    (item) => item.name === params.workflowId,
  );
  if (!entry) {
    throw new ServiceError(
      "not_found",
      `Workflow not found: ${params.workflowId}`,
    );
  }

  let yaml: string;
  try {
    yaml = await fs.readFile(entry.template_path, "utf8");
  } catch {
    throw new ServiceError(
      "internal",
      `Failed to read workflow file: ${params.workflowId}`,
    );
  }

  // Stages are best-effort: a malformed template still returns its raw YAML so
  // the editor keeps working; the Run panel simply falls back to live events.
  let stages: WorkflowStageInfo[] = [];
  try {
    const parsed = parseWorkflowTemplate(entry.template_path);
    if (parsed.template) stages = projectWorkflowStages(parsed.template);
  } catch {
    stages = [];
  }

  return { yaml, stages };
}

export async function updateWorkflowYaml(params: {
  repoRootPath?: string;
  registryPath?: string;
  workflowId: string;
  yaml: string;
}): Promise<{
  workflowId: string;
  yaml: string;
  yamlPath: string;
  registryPath: string;
  filename: string;
  warnings: string[];
}> {
  if (!params.registryPath) {
    throw new ServiceError(
      "not_configured",
      "Workflow registry not configured",
    );
  }
  if (!params.repoRootPath) {
    throw new ServiceError(
      "not_configured",
      "Workflow update requires repoRootPath to be configured",
    );
  }

  const draft = parseWorkflowYaml(params.yaml);
  const registry = loadWorkflowGeneratorRegistry(params.repoRootPath);
  const validation = validateDraft(draft, registry);
  if (validation.errors.length > 0) {
    throw new ServiceError("bad_request", "Workflow is invalid", {
      details: validation.errors,
      warnings: validation.warnings,
    });
  }

  try {
    const saved = await updateExistingWorkflowYaml({
      workflowId: params.workflowId,
      yaml: params.yaml,
      registryPath: params.registryPath,
    });
    return {
      workflowId: saved.workflowId,
      yaml: saved.yaml,
      yamlPath: saved.yamlPath,
      registryPath: saved.registryPath,
      filename: saved.filename,
      warnings: validation.warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ServiceError(
      message.startsWith("Workflow not found:") ? "not_found" : "bad_request",
      message,
    );
  }
}

export async function deleteWorkflowById(params: {
  registryPath?: string;
  workflowId: string;
}): Promise<void> {
  if (!params.registryPath) {
    throw new ServiceError(
      "not_configured",
      "Workflow registry not configured",
    );
  }
  try {
    await deleteWorkflow({
      workflowId: params.workflowId,
      registryPath: params.registryPath,
    });
  } catch (error) {
    if (error instanceof WorkflowDeleteNotFoundError) {
      throw new ServiceError("not_found", error.message);
    }
    throw new ServiceError(
      "internal",
      error instanceof Error
        ? error.message
        : `Failed to delete workflow: ${params.workflowId}`,
    );
  }
}

export function listWorkflowGeneratorTeams(repoRootPath?: string): unknown {
  if (!repoRootPath) {
    throw new ServiceError(
      "not_configured",
      "Workflow generator requires repoRootPath to be configured",
    );
  }
  return loadWorkflowGeneratorRegistry(repoRootPath);
}

export async function runWorkflowGeneratorTurn(params: {
  repoRootPath?: string;
  registry?: ReturnType<typeof loadWorkflowGeneratorRegistry>;
  history: ChatTurn[];
  currentDraft: WorkflowDraft | null;
  provider?: string;
  model?: string;
  signal: AbortSignal;
  /** Display-only observer for the reply's prose while it is generating. */
  onTextDelta?: (text: string) => void;
  /** Called once the turn knows its pair, before anything is sent. */
  onSelectionResolved?: (selection: ModelSelectionRecord) => Promise<void>;
}): Promise<{
  message: string;
  draft: WorkflowDraft | null;
  warnings: string[];
  yaml: string | null;
  mermaid: string | null;
  handoff?: {
    targetMode: "agents" | "teams" | "workflows";
    prompt: string;
    reason: string;
  };
  meta: {
    model: string;
    fallback: boolean;
    reason?: string;
    /** How that model was decided, when the turn got far enough to decide. */
    selection?: ModelSelectionRecord;
  };
}> {
  if (!params.repoRootPath) {
    throw new ServiceError(
      "not_configured",
      "Workflow generator requires repoRootPath to be configured",
    );
  }
  const registry =
    params.registry ?? loadWorkflowGeneratorRegistry(params.repoRootPath);
  const result = await runGeneratorTurn({
    history: params.history,
    currentDraft: params.currentDraft,
    repoRoot: params.repoRootPath,
    registry,
    ...whenDefined(params.provider, (definedValue) => ({ provider: definedValue })),
    ...whenDefined(params.model, (definedValue) => ({ model: definedValue })),
    signal: params.signal,
    ...whenDefined(params.onTextDelta, (onTextDelta) => ({ onTextDelta })),
    ...whenDefined(params.onSelectionResolved, (onSelectionResolved) => ({
      onSelectionResolved,
    })),
  });
  const draft = result.response.draft;
  const validation = validateDraft(draft, registry);
  const warnings = [
    ...(result.response.warnings ?? []),
    ...validation.warnings,
    ...validation.errors.map((err) => `validation: ${err}`),
  ];
  return {
    message: result.response.message,
    draft,
    warnings,
    yaml: draft ? buildWorkflowYaml(draft) : null,
    mermaid: draft ? buildWorkflowMermaid(draft) : null,
    ...whenDefined(result.response.handoff, (definedValue) => ({ handoff: definedValue })),
    meta: {
      model: result.model,
      fallback: result.fallback,
      ...whenDefined(result.reason, (reason) => ({ reason })),
      ...whenDefined(result.selection, (selection) => ({ selection })),
    },
  };
}

export function validateWorkflowYaml(params: {
  repoRootPath?: string;
  yaml: string;
}): {
  valid: boolean;
  draft: WorkflowDraft;
  warnings: string[];
  errors: string[];
  mermaid: string | null;
} {
  if (!params.repoRootPath) {
    throw new ServiceError(
      "not_configured",
      "Workflow generator requires repoRootPath to be configured",
    );
  }
  const registry = loadWorkflowGeneratorRegistry(params.repoRootPath);
  const draft = parseWorkflowYaml(params.yaml);
  const validation = validateDraft(draft, registry);
  return {
    valid: validation.errors.length === 0,
    draft,
    warnings: validation.warnings,
    errors: validation.errors,
    mermaid:
      validation.errors.length === 0 ? buildWorkflowMermaid(draft) : null,
  };
}

export async function saveGeneratedWorkflow(params: {
  repoRootPath?: string;
  workflowsRegistryPath?: string;
  body: GeneratorSaveBody;
  signal?: AbortSignal;
}): Promise<{
  workflowId: string;
  yamlPath: string;
  registryPath: string;
  filename: string;
  warnings: string[];
}> {
  if (!params.repoRootPath) {
    throw new ServiceError(
      "not_configured",
      "Workflow generator requires repoRootPath to be configured",
    );
  }
  const registry = loadWorkflowGeneratorRegistry(params.repoRootPath);
  const draft = params.body.yaml
    ? parseWorkflowYaml(params.body.yaml)
    : params.body.draft === undefined
      ? undefined
      : parseWorkflowYaml(JSON.stringify({ workflow: params.body.draft }));
  if (!draft) {
    throw new ServiceError(
      "bad_request",
      "A workflow draft or YAML body is required",
    );
  }
  const validation = validateDraft(draft, registry);
  if (validation.errors.length > 0) {
    throw new ServiceError("bad_request", "Draft is invalid", {
      details: validation.errors,
      warnings: validation.warnings,
    });
  }

  const registryPath =
    params.workflowsRegistryPath ??
    path.join(params.repoRootPath, "workflows", "registry.yaml");
  const workflowId = safeWorkflowId(params.body.filename ?? draft.id);
  if (!params.body.replaceWorkflowId) {
    const existing = parseWorkflowRegistry(registryPath).entries.find(
      (entry) => entry.name === workflowId,
    );
    const generatedPath = path.join(
      path.dirname(registryPath),
      "user-generated",
      `${workflowId}.yaml`,
    );
    const existingPath =
      existing?.template_path ??
      (fsSync.existsSync(generatedPath) ? generatedPath : null);
    if (existingPath) {
      const requestedDraft = { ...draft, id: workflowId };
      let existingDraft: WorkflowDraft | null = null;
      try {
        existingDraft = parseWorkflowYaml(
          await fs.readFile(existingPath, "utf8"),
        );
      } catch {
        // A malformed or unreadable collision must never be overwritten.
      }
      const isIdempotent =
        existingDraft !== null &&
        isDeepStrictEqual(existingDraft, requestedDraft);
      if (isIdempotent && existing) {
        return {
          workflowId,
          yamlPath: existingPath,
          registryPath,
          filename: path.basename(existingPath),
          warnings: validation.warnings,
        };
      }
      if (!isIdempotent) {
        throw new ServiceError(
          "conflict",
          `Workflow already exists: ${workflowId}. Choose a different id or explicitly replace it.`,
        );
      }
      // A matching orphaned file can be safely rewritten so its missing
      // registry entry is repaired after an interrupted save.
    }
  }

  let saved: {
    workflowId: string;
    yamlPath: string;
    registryPath: string;
    filename: string;
  };
  try {
    saved = params.body.yaml
      ? params.body.replaceWorkflowId
        ? await updateExistingWorkflowYaml({
            workflowId: params.body.replaceWorkflowId,
            yaml: params.body.yaml,
            registryPath,
            ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
          })
        : await saveWorkflowYaml({
            yaml: params.body.yaml,
            ...whenDefined(params.body.filename, (definedValue) => ({ filename: definedValue })),
            repoRoot: params.repoRootPath,
            registryPath,
            ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
          })
      : await saveWorkflow({
          draft,
          filename: params.body.filename ?? draft.id,
          repoRoot: params.repoRootPath,
          registryPath,
          ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
        });
  } catch (error) {
    if (error instanceof WorkflowWriteConflictError) {
      throw new ServiceError("conflict", error.message);
    }
    throw error;
  }

  return {
    workflowId: saved.workflowId,
    yamlPath: saved.yamlPath,
    registryPath: saved.registryPath,
    filename: saved.filename,
    warnings: validation.warnings,
  };
}

function safeWorkflowId(input: string): string {
  const stripped = input.trim().replace(/\.ya?ml$/i, "");
  return (
    stripped.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "") ||
    "workflow"
  );
}

export function parseGeneratorTurnBody(payload: unknown): {
  jobId?: string;
  history: ChatTurn[];
  currentDraft: WorkflowDraft | null;
  provider?: string;
  model?: string;
} {
  return parseServiceRequest(generatorTurnRequestSchema, payload);
}

/** Parses an optional `provider`/`model` override field from a request body. */
export function optionalModelField(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ServiceError("bad_request", `Field ${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface GeneratorSaveBody {
  draft?: Record<string, unknown>;
  yaml?: string;
  filename?: string;
  replaceWorkflowId?: string;
}

export function parseGeneratorSaveBody(payload: unknown): GeneratorSaveBody {
  return parseServiceRequest(generatorSaveRequestSchema, payload);
}

export function parseWorkflowUpdateBody(payload: unknown): { yaml: string } {
  return parseServiceRequest(workflowUpdateRequestSchema, payload);
}

export function parseGeneratorValidateYamlBody(payload: unknown): {
  yaml: string;
} {
  return parseServiceRequest(generatorValidateYamlRequestSchema, payload);
}

function summarizeWorkflowForChat(
  id: string,
  registryDescription: string | undefined,
  template: WorkflowTemplate,
): AvailableWorkflow {
  const iterationLoops = template.steps.flatMap(describeStepIterationLoops);
  return {
    id,
    ...whenDefined(registryDescription ?? template.description, (definedValue) => ({ description: definedValue })),
    stages: template.steps.map((step) => ({
      id: step.id,
      ...whenDefined(step.team, (team) => ({ team })),
      resultArtifact: step.result_artifact,
      ...whenDefined(step.requested_result_type, (requestedResultType) => ({ requestedResultType })),
      ...whenDefined(step.handoff
        ? `${step.handoff.from_step}:${step.handoff.from_artifact} -> ${step.handoff.to_artifact}`
        : undefined, (handoff) => ({ handoff })),
      ...whenDefined(describeStepIterationLoops(step).join("; ") || undefined, (iteration) => ({ iteration })),
    })),
    iterationLoops,
    ...whenDefined(template.output.from_step && template.output.artifact
        ? `${template.output.from_step}:${template.output.artifact}`
        : undefined, (definedValue) => ({ output: definedValue })),
  };
}

function describeStepIterationLoops(step: WorkflowStep): string[] {
  const levels = step.runtime_overrides?.levels ?? {};
  return Object.entries(levels).flatMap(([levelId, override]) => {
    const loops: string[] = [];
    if (override.discussion) {
      const min = override.discussion.min_rounds;
      const max = override.discussion.max_rounds;
      const rounds =
        min !== undefined && max !== undefined && min === max
          ? `${max} discussion ${max === 1 ? "round" : "rounds"}`
          : min !== undefined && max !== undefined
            ? `${min}-${max} discussion rounds`
            : max !== undefined
              ? `up to ${max} discussion ${max === 1 ? "round" : "rounds"}`
              : "discussion loop";
      const participants = override.discussion.participants?.length
        ? ` with ${override.discussion.participants.join(", ")}`
        : "";
      loops.push(`${step.id}/${levelId}: ${rounds}${participants}`);
    }
    if (override.review?.max_iterations !== undefined) {
      const maxIterations = override.review.max_iterations;
      loops.push(
        `${step.id}/${levelId}: up to ${maxIterations} review ${
          maxIterations === 1 ? "iteration" : "iterations"
        }`,
      );
    }
    return loops;
  });
}
