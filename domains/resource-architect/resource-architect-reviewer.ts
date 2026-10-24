import * as path from "node:path";
import * as z from "zod/v4";
import {
  readAgentModelChoice,
  resolveAgentModelChoice,
  type AppDefaultModelState,
  type ModelSelection,
  type ProviderModelPair,
} from "../../contracts/agent-model-selection.js";
import { parseAgentFrontmatter, readAgentProviderOptions } from "../../parsers/load-agent.js";
import {
  THINKING_REQUEST_VALUES,
  type ThinkingLevel,
} from "../../contracts/thinking-levels.js";
import { getRuntimeDefaultEffort } from "../provider/default-effort-selection.js";

const REVIEWER_ID = "reviewer-of-agent-architect";
const reviewerFrontmatterSchema = z.object({
  name: z.literal(REVIEWER_ID),
  system: z.literal("true"),
  // The same vocabulary the Agent editor offers, because this persona is
  // edited through it. A narrower list here would make a valid persona invalid
  // and stop review entirely; an unset level follows the application default.
  // A function, so the application default is read when a persona is parsed.
  // A bare value would freeze whatever the setting was when this module first
  // loaded, and this schema is built once per process.
  thinking: z.enum(THINKING_REQUEST_VALUES).default(() => getRuntimeDefaultEffort()),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  provider_options: z.string().optional(),
}).refine((value) => (value.provider === undefined) === (value.model === undefined));

export interface ResourceArchitectReviewerConfig {
  readonly reviewerId: typeof REVIEWER_ID;
  readonly systemPrompt: string;
  readonly thinking: ThinkingLevel;
  readonly selection: ModelSelection;
  readonly providerOptions: Readonly<Record<string, string | number | boolean>>;
  /** Available only for an explicit review selection that differs from this snapshot. */
  readonly defaultFallback: ProviderModelPair | null;
}

export type ResourceArchitectReviewerConfigResult =
  | { readonly ok: true; readonly config: ResourceArchitectReviewerConfig }
  | { readonly ok: false; readonly error: {
    readonly code: "reviewer-persona-missing" | "reviewer-persona-invalid" | "reviewer-selection-unavailable";
    readonly message: string;
    readonly requestedReviewer?: ProviderModelPair;
  } };

/** Load from the same editable project root as the Architect, once for each turn. */
export function loadResourceArchitectReviewerConfig(
  repoRoot: string,
  defaultSnapshot: AppDefaultModelState,
): ResourceArchitectReviewerConfigResult {
  const personaPath = path.join(repoRoot, "agents", REVIEWER_ID, `${REVIEWER_ID}.md`);
  let parsed: ReturnType<typeof parseAgentFrontmatter>;
  try {
    parsed = parseAgentFrontmatter(personaPath);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return reviewerConfigFailure(missing ? "reviewer-persona-missing" : "reviewer-persona-invalid");
  }
  const frontmatter = reviewerFrontmatterSchema.safeParse(parsed.frontmatter);
  if (!frontmatter.success || parsed.body.trim().length === 0) {
    return reviewerConfigFailure("reviewer-persona-invalid");
  }
  const reading = readAgentModelChoice({
    provider: frontmatter.data.provider,
    model: frontmatter.data.model,
  });
  if (!reading.choice) return reviewerConfigFailure("reviewer-persona-invalid");
  const resolved = resolveAgentModelChoice(reading.choice, defaultSnapshot);
  const requestedReviewer = reading.choice.mode === "explicit"
    ? { provider: reading.choice.provider, model: reading.choice.model }
    : defaultSnapshot.status === "unset" ? undefined
      : { provider: defaultSnapshot.provider, model: defaultSnapshot.model };
  const options = readAgentProviderOptions(frontmatter.data.provider_options);
  if (options.diagnostics.length > 0) {
    return reviewerConfigFailure("reviewer-persona-invalid", requestedReviewer);
  }
  if (!resolved.ok) return reviewerConfigFailure("reviewer-selection-unavailable", requestedReviewer);
  const defaultFallback = reading.choice.mode === "explicit"
    && defaultSnapshot.status === "available"
    && (defaultSnapshot.provider !== resolved.selection.provider || defaultSnapshot.model !== resolved.selection.model)
    ? { provider: defaultSnapshot.provider, model: defaultSnapshot.model }
    : null;
  return {
    ok: true,
    config: {
      reviewerId: REVIEWER_ID,
      systemPrompt: parsed.body,
      thinking: frontmatter.data.thinking,
      selection: resolved.selection,
      // Settings belong to the explicitly configured pair, never an inherited one.
      providerOptions: reading.choice.mode === "explicit" ? options.options : {},
      defaultFallback,
    },
  };
}

function reviewerConfigFailure(
  code: Extract<ResourceArchitectReviewerConfigResult, { ok: false }>["error"]["code"],
  requestedReviewer?: ProviderModelPair,
): ResourceArchitectReviewerConfigResult {
  const message = code === "reviewer-persona-missing"
    ? "Reviewer of Agent Architect persona is missing."
    : code === "reviewer-selection-unavailable"
      ? "Reviewer of Agent Architect has no available application default model."
      : "Reviewer of Agent Architect configuration is invalid.";
  return { ok: false, error: { code, message, ...(requestedReviewer ? { requestedReviewer } : {}) } };
}
