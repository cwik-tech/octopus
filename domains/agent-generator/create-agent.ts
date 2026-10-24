/**
 * LLM call for the Agent Architect.
 *
 * Reads the selected `SKILL.md` files, runs duplicate detection against the
 * existing `agents/` folder (set-equality on skill folder names), and — if no
 * duplicate is found or the caller opted to overwrite/duplicate — asks the
 * configured architect model to author a persona markdown file.
 *
 * The architect's provider/model is read from the workflow-architect team
 * config (same control surface as the workflow generator). API keys come
 * from the same environment variables. If anything is missing, the call
 * returns a fallback response so the UI can render a graceful error.
 */

import { whenDefined } from "../../core/optional-properties.js"
import type { DocumentSource } from '../../contracts/document-reference.js';
import { prepareModelDocuments } from '../document-access/model-document-preparation.js';
import { assertDocumentRequestBudget } from '../document-access/document-request-budget.js';
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadArchitectConfig,
  WorkflowArchitectNotConfiguredError,
} from "../provider/architect-model-config.js";
import {
  callModel,
  readApiKey,
  type ModelCallParams,
  type ModelMessage,
} from "../provider/model-client.js";
import { CHAT_VISUALIZATION_POLICY } from "../../core/chat-visualization-policy.js";
import { combineAbortSignals, PROVIDER_HTTP_REQUEST_TIMEOUT_MS } from "../../core/timeout-manager.js";
import { listAgents } from "./list-agents.js";
import {
  buildAgentArchitectSystemPrompt,
  normalizeGeneratedPersona,
  renderSkillsBlock,
} from "./agent-prompt.js";
import { renderAgentLibraryContextBlock } from "./agent-context.js";
import type {
  ChatTurn,
  DraftAgentRequest,
  DraftAgentResponse,
  DraftAgentSuccess,
} from "./types.js";

export interface RunCreateAgentInput extends DraftAgentRequest {
  referenceDocuments?: readonly DocumentSource[];
  documentReviewCacheDir?: string;
  repoRoot: string;
  signal?: AbortSignal;
}

export async function runCreateAgent(
  input: RunCreateAgentInput,
): Promise<DraftAgentResponse> {
  throwIfAborted(input.signal);

  const skillNames = skillFolderNames(input.skillPaths);

  if (skillNames.length > 0 && input.duplicatePolicy === undefined) {
    const existing = findExistingAgentWithSkills(input.repoRoot, skillNames);
    if (existing) {
      return { duplicate: { existingAgentName: existing } };
    }
  }

  const skillBodies = readSkillBodies(input.skillPaths);
  const skillsBlock = renderSkillsBlock(skillBodies);

  let config;
  try {
    config = loadArchitectConfig(input.repoRoot);
  } catch (error) {
    if (error instanceof WorkflowArchitectNotConfiguredError) {
      return fallback(input, error.message, skillNames);
    }
    return fallback(
      input,
      error instanceof Error ? error.message : String(error),
      skillNames,
    );
  }

  const provider = input.provider?.trim() || config.provider;
  const model = input.model?.trim() || config.model;

  const keyResult = readApiKey(provider);
  if (keyResult.apiKey == null) {
    return fallback(input, `${keyResult.envVar} is not set`, skillNames);
  }

  const systemPrompt = [
    buildAgentArchitectSystemPrompt(input.repoRoot).trim(),
    CHAT_VISUALIZATION_POLICY,
    renderAgentLibraryContextBlock({ repoRoot: input.repoRoot }),
    skillsBlock.trim(),
  ].join("\n\n");
  const messages = buildMessages(input.chatHistory);
  // Full persona and skill authoring can finish successfully after more than
  // two minutes without a Codex event. Bound the whole draft/repair operation
  // by the existing model-request budget rather than the chat silence limit.
  const authoringSignal = combineAbortSignals(
    input.signal,
    AbortSignal.timeout(PROVIDER_HTTP_REQUEST_TIMEOUT_MS),
  );
  const preparation = await prepareModelDocuments({ documents: input.referenceDocuments ?? [], question: input.chatHistory.filter((turn) => turn.role === 'user').at(-1)?.text ?? 'Author the planned Agent using the admitted sources.', apiKey: keyResult.apiKey, model: { provider, model, signal: authoringSignal }, ...whenDefined(input.documentReviewCacheDir, (cacheDir) => ({ cacheDir })) });
  if (preparation.context) messages.push({ role: 'user', content: preparation.context });
  if ((input.referenceDocuments?.length ?? 0) > 0) assertDocumentRequestBudget({ provider, model, request: { systemPrompt, messages } });
  const authoringParams: ModelCallParams = {
    provider,
    model,
    systemPrompt,
    messages,
    cliStallAbortMs: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
    signal: authoringSignal,
  };

  throwIfAborted(input.signal);
  const firstAttempt = await callModel(keyResult.apiKey, authoringParams);
  throwIfAborted(input.signal);
  if (!firstAttempt.ok) {
    return fallback(input, firstAttempt.reason, skillNames);
  }

  const parsedFirst = tryParseDraft(
    firstAttempt.text,
    skillNames.length === 0,
  );
  if (parsedFirst.ok) {
    if ("value" in parsedFirst) {
      return finalize(parsedFirst.value, firstAttempt.model, false, skillNames);
    }
    return { needsInput: true, message: parsedFirst.message };
  }

  const repairMessages: ModelMessage[] = [
    ...messages,
    { role: "assistant", content: firstAttempt.text },
    {
      role: "user",
      content:
        `Your previous reply was not valid JSON in the required shape: ${parsedFirst.reason}. Resend a single JSON object wrapped in \`\`\`json ... \`\`\` with fields "message", "suggestedName", and "personaMarkdown"${
          skillNames.length === 0
            ? ', plus a non-empty "generatedSkills" array because no existing skills were selected.'
            : "."
        }`,
    },
  ];
  if ((input.referenceDocuments?.length ?? 0) > 0) assertDocumentRequestBudget({ provider, model, request: { systemPrompt, messages: repairMessages } });
  const second = await callModel(keyResult.apiKey, {
    ...authoringParams,
    messages: repairMessages,
  });
  throwIfAborted(input.signal);
  if (!second.ok) {
    return fallback(input, second.reason, skillNames);
  }
  const parsedSecond = tryParseDraft(second.text, skillNames.length === 0);
  if (parsedSecond.ok) {
    if ("value" in parsedSecond) {
      return finalize(parsedSecond.value, second.model, false, skillNames);
    }
    return { needsInput: true, message: parsedSecond.message };
  }

  return fallback(
    input,
    `Architect returned non-JSON output twice. Last text: ${second.text.slice(0, 200)}`,
    skillNames,
  );
}

function buildMessages(history: ChatTurn[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.text });
  }
  if (messages.length === 0) {
    messages.push({
      role: "user",
      content:
        "(No chat brief provided. Author the persona from the selected skills alone — infer the role, voice, and purpose from the skill contents.)",
    });
  }
  return messages;
}

interface GeneratedSkillDraft {
  name: string;
  body: string;
}

interface ParsedDraft {
  message: string;
  suggestedName: string;
  personaMarkdown: string;
  generatedSkills?: GeneratedSkillDraft[];
}

interface ParseOk {
  ok: true;
  value: ParsedDraft;
}
interface ParseNeedsInput {
  ok: true;
  needsInput: true;
  message: string;
}
interface ParseErr {
  ok: false;
  reason: string;
}

function tryParseDraft(
  text: string,
  requireGeneratedSkills: boolean,
): ParseOk | ParseNeedsInput | ParseErr {
  const json = extractJsonBlock(text);
  if (!json) {
    return { ok: false, reason: "no JSON object found in reply" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      reason: `JSON parse failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "top-level value is not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.needsInput === true) {
    const message =
      typeof obj.message === "string" ? obj.message.trim() : "";
    if (!message) {
      return { ok: false, reason: "needsInput response missing message" };
    }
    return { ok: true, needsInput: true, message };
  }
  const suggestedName =
    typeof obj.suggestedName === "string" ? obj.suggestedName.trim() : "";
  const personaMarkdown =
    typeof obj.personaMarkdown === "string" ? obj.personaMarkdown : "";
  const message =
    typeof obj.message === "string"
      ? obj.message
      : "(architect returned no message)";
  let generatedSkills: GeneratedSkillDraft[] | undefined;
  if (Array.isArray(obj.generatedSkills)) {
    generatedSkills = [];
    for (const item of obj.generatedSkills) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).body === "string"
      ) {
        generatedSkills.push({
          name: sanitizeSkillName(
            String((item as Record<string, unknown>).name),
          ),
          body: String((item as Record<string, unknown>).body),
        });
      }
    }
    if (generatedSkills.length === 0) {
      generatedSkills = undefined;
    }
  }
  if (!suggestedName) {
    return { ok: false, reason: "missing suggestedName" };
  }
  if (!personaMarkdown.trim()) {
    return { ok: false, reason: "missing personaMarkdown" };
  }
  if (requireGeneratedSkills && !generatedSkills?.length) {
    return {
      ok: false,
      reason: "missing generatedSkills for chat-created agent",
    };
  }
  return {
    ok: true,
    value: {
      message,
      suggestedName,
      // Enforced, not merely asked for: a generated Agent inherits the one
      // application default, and the model that wrote it must not pin it.
      personaMarkdown: normalizeGeneratedPersona(personaMarkdown),
      ...whenDefined(generatedSkills, (presentGeneratedSkills) => ({
        generatedSkills: presentGeneratedSkills,
      })),
    },
  };
}

function finalize(
  parsed: ParsedDraft,
  model: string,
  fallback: boolean,
  _skillNames: string[],
): DraftAgentSuccess {
  return {
    suggestedName: sanitizeName(parsed.suggestedName),
    personaMarkdown: parsed.personaMarkdown,
    ...whenDefined(parsed.generatedSkills, (generatedSkills) => ({ generatedSkills })),
    meta: { model, fallback },
  };
}

function fallback(
  input: RunCreateAgentInput,
  reason: string,
  skillNames: string[],
): DraftAgentResponse {
  const chatBrief = latestUserBrief(input.chatHistory);
  if (skillNames.length === 0) {
    return inferredDraftFromBrief(chatBrief, reason);
  }

  const onlySkillName = skillNames[0]
  const fallbackName = sanitizeName(
    onlySkillName ?? `agent-${Date.now()}`,
  );
  // No provider or model: this Agent inherits the one application default,
  // like every other newly created Agent.
  const fallbackBody = renderFallbackPersona(fallbackName, skillNames, reason);
  return {
    suggestedName: fallbackName,
    personaMarkdown: fallbackBody,
    meta: { model: "fallback", fallback: true, reason },
  };
}

function inferredDraftFromBrief(
  brief: string,
  reason: string,
): DraftAgentSuccess {
  const profile = inferAgentProfile(brief);
  const skillName = profile.skillName;
  return {
    suggestedName: profile.name,
    // No provider or model: the Agent this fallback writes inherits the one
    // application default, exactly as one written by the architect does. The
    // caller's own authoring pair is not this Agent's runtime.
    personaMarkdown: renderInferredPersona(profile),
    generatedSkills: [
      {
        name: skillName,
        body: renderInferredSkill(profile, reason),
      },
    ],
    meta: { model: "fallback", fallback: true, reason },
  };
}

interface InferredAgentProfile {
  name: string;
  displayName: string;
  description: string;
  purpose: string;
  skillName: string;
  skillTitle: string;
  /**
   * The generated skill's frontmatter description. Per the Agent Skills
   * specification it must state both what the skill does and when to use it,
   * because it is the only text an agent sees when deciding to activate.
   */
  skillDescription: string;
  domain: string;
  primaryOutput: string;
  evidenceStandard: string;
  heuristics: string[];
  questions: string[];
  workflow: string[];
  reportItems: string[];
  methodSteps: string[];
  qualityBar: string[];
}

function inferAgentProfile(brief: string): InferredAgentProfile {
  const normalized = brief.toLowerCase();
  if (/\bcustomer discovery\b|\bcustomer interviews?\b|\buser research\b/.test(normalized)) {
    return {
      name: "customer-discovery-specialist",
      displayName: "Customer Discovery Specialist",
      description:
        "Plans, conducts, and synthesizes customer discovery to validate problems, segments, and buying triggers.",
      purpose:
        "Help users turn vague market assumptions into concrete customer discovery plans, interview scripts, evidence standards, and synthesis outputs that reveal real pains, alternatives, urgency, and buying criteria.",
      skillName: "customer-discovery-research",
      skillTitle: "Customer Discovery Research",
      skillDescription:
        "Plan, run, and synthesize customer discovery interviews that test segment, pain, urgency, existing alternatives, and buying triggers. Use when defining a target customer, writing non-leading behavioral interview questions, setting evidence thresholds for discovery, or turning interview notes into product, pricing, messaging, or segment decisions.",
      domain: "customer discovery",
      primaryOutput:
        "a customer discovery plan with target segment, assumptions, interview script, evidence thresholds, synthesis tags, and next decisions",
      evidenceStandard:
        "direct customer conversations, observed behavior, concrete examples, current alternatives, willingness-to-pay signals, and repeated patterns across a defined segment",
      heuristics: [
        "Problem before solution: validate the customer's situation, pain, and current workaround before discussing an idea.",
        "Specific beats average: one concrete story about the last time the problem happened is more useful than a general opinion.",
        "Behavior beats preference: treat past actions, purchases, workarounds, and switching attempts as stronger evidence than stated interest.",
        "Segment tightly: patterns only matter when they repeat inside a coherent customer segment.",
      ],
      questions: [
        "Who exactly should be interviewed, and what situation qualifies them?",
        "What problem, workaround, or buying trigger are we trying to validate?",
        "What must we learn before building or selling more?",
        "What interview question would accidentally pitch the solution instead of discovering the truth?",
        "What evidence would change the next product, positioning, or go-to-market decision?",
      ],
      workflow: [
        "State the riskiest customer, problem, and demand assumptions.",
        "Define the target interview segment and disqualifiers.",
        "Draft non-leading discovery questions focused on recent behavior.",
        "Set evidence thresholds and decision rules before interviews happen.",
        "Synthesize patterns, contradictions, quotes, alternatives, and urgency signals.",
        "Recommend the next validation step or product decision.",
      ],
      reportItems: [
        "Target segment",
        "Assumptions to test",
        "Interview plan",
        "Discovery questions",
        "Evidence threshold",
        "Synthesis framework",
        "Decision recommendations",
        "Open risks",
      ],
      methodSteps: [
        "Define the target customer segment and qualifying situation.",
        "List problem, urgency, alternative, budget, and buying-process assumptions.",
        "Write interview questions that ask about recent behavior instead of opinions.",
        "Add probes for current alternatives, failed workarounds, decision criteria, and cost of inaction.",
        "Predefine evidence thresholds, sample size, and decision rules.",
        "Synthesize notes into repeated patterns, outliers, direct quotes, and invalidated assumptions.",
        "Translate findings into product, messaging, pricing, or segment decisions.",
      ],
      qualityBar: [
        "Questions are non-leading and do not pitch the solution.",
        "Every assumption has an evidence threshold and decision rule.",
        "Findings separate direct evidence from interpretation.",
        "Recommendations cite observed behavior or repeated customer stories.",
      ],
    };
  }

  if (/\bbusiness hypothes(?:is|es)\b|\bhypothesis\b|\bassumptions?\b/.test(normalized)) {
    return {
      name: "business-hypothesis-expert",
      displayName: "Business Hypothesis Expert",
      description:
        "Turns business claims into clear hypotheses, validation plans, falsification criteria, and learning decisions.",
      purpose:
        "Help users convert strategic guesses, startup ideas, and go-to-market claims into testable hypotheses with explicit assumptions, evidence thresholds, experiment design, and decision rules.",
      skillName: "business-hypothesis-validation",
      skillTitle: "Business Hypothesis Validation",
      skillDescription:
        "Turn business claims, strategy assertions, and go-to-market assumptions into falsifiable hypotheses with evidence thresholds, experiments, and decision rules. Use when validating a business idea, ranking the riskiest assumptions, designing the smallest informative test, or deciding from evidence whether to continue, pivot, retest, or stop.",
      domain: "business hypothesis creation and validation",
      primaryOutput:
        "a hypothesis board with assumptions, falsification criteria, cheapest useful tests, evidence thresholds, and decision rules",
      evidenceStandard:
        "observable customer behavior, transaction signals, repeated qualitative evidence, credible market constraints, and pre-registered experiment outcomes",
      heuristics: [
        "Falsify first: design the test most likely to disprove the favorite assumption.",
        "Cheapest useful signal: pick the smallest experiment that can meaningfully update the decision.",
        "Base rates matter: compare the claim with similar markets, channels, and business models.",
        "Separate belief from evidence: confidence only rises when a predefined signal appears.",
      ],
      questions: [
        "What single assumption, if false, breaks the plan?",
        "What evidence would make us stop, pivot, or double down?",
        "Which claim is about desirability, feasibility, viability, or channel access?",
        "What is the cheapest test that can produce a real signal this week?",
        "What decision will be made after the evidence is collected?",
      ],
      workflow: [
        "Extract business claims from the user's idea or plan.",
        "Rewrite each claim as a testable hypothesis.",
        "Rank assumptions by uncertainty and business impact.",
        "Define falsification criteria, evidence thresholds, and decision rules.",
        "Design low-cost validation tests for the highest-risk assumptions.",
        "Return a prioritized hypothesis board and next test plan.",
      ],
      reportItems: [
        "Business claim",
        "Testable hypothesis",
        "Assumption type",
        "Risk ranking",
        "Evidence threshold",
        "Falsification criteria",
        "Validation test",
        "Decision rule",
      ],
      methodSteps: [
        "Extract explicit and hidden claims from the business idea.",
        "Rewrite claims into hypotheses with customer, behavior, condition, and expected signal.",
        "Classify assumptions as desirability, viability, feasibility, channel, pricing, or retention.",
        "Rank assumptions by uncertainty and consequence.",
        "Define what would falsify each assumption before testing.",
        "Design the smallest informative experiment with cost, timeline, sample, and metric.",
        "State the decision rule for stop, continue, pivot, or retest.",
      ],
      qualityBar: [
        "Every hypothesis can be disproven by observable evidence.",
        "Tests include sample, metric, threshold, and decision rule.",
        "The plan prioritizes learning over proving the idea right.",
        "Survey opinions are not treated as validation without behavioral evidence.",
      ],
    };
  }

  if (/\bvalue propositions?\b/.test(normalized)) {
    return {
      name: "value-proposition-strategist",
      displayName: "Value Proposition Strategist",
      description:
        "Creates, sharpens, and validates customer value propositions and business assumptions.",
      purpose:
        "Help users turn a rough offer, market, or product idea into a crisp value proposition with clear customer pains, promised outcomes, proof points, differentiation, and testable assumptions.",
      skillName: "value-proposition-design",
      skillTitle: "Value Proposition Design",
      skillDescription:
        "Create, critique, and validate customer value propositions and the assumptions behind them, separating known facts from risky assumptions and pairing each with a validation test. Use when defining a target segment and its triggering situation, drafting or sharpening positioning language, or checking whether a proposition is specific, believable, and testable.",
      domain: "value proposition creation and assumption validation",
      primaryOutput:
        "a structured value proposition brief with customer segment, core promise, differentiated proof, risk assumptions, and validation tests",
      evidenceStandard:
        "specific customer segments, observable pains, explicit alternatives, credible proof, and assumptions that can be tested with customer conversations, landing pages, prototypes, or sales evidence",
      heuristics: [
        "Customer first: start with the specific customer, their situation, and the job they are trying to get done.",
        "Pain before promise: connect the offer to an urgent pain, costly friction, or meaningful desired outcome.",
        "Proof beats adjectives: replace broad claims with concrete mechanisms, examples, and evidence.",
        "Assumptions must be testable: turn the riskiest guesses into validation tests.",
      ],
      questions: [
        "Who is the exact customer segment and what situation triggers the need?",
        "What painful alternative do they use today?",
        "What outcome does the offer promise in plain language?",
        "Why should the customer believe the promise?",
        "Which assumption would break the proposition if it were false?",
      ],
      workflow: [
        "Restate the customer, situation, and desired outcome.",
        "Map pains, alternatives, gains, and buying triggers.",
        "Draft the core value proposition in plain language.",
        "Identify proof points, differentiators, and weak assumptions.",
        "Propose validation tests for the riskiest assumptions.",
        "Deliver the structured value proposition brief.",
      ],
      reportItems: [
        "Customer segment",
        "Current pain or alternative",
        "Core value proposition",
        "Proof and differentiation",
        "Key assumptions",
        "Recommended validation tests",
        "Open questions",
      ],
      methodSteps: [
        "Define the target customer segment and the situation that creates urgency.",
        "Identify the current alternative, workaround, or status quo.",
        "List the customer's pains, desired gains, and decision criteria.",
        "Draft the value proposition as: \"For [customer] who [need/pain], this helps [outcome] by [mechanism/proof].\"",
        "Separate claims into known facts, plausible assumptions, and risky assumptions.",
        "Design validation tests for the riskiest assumptions, including evidence threshold and decision rule.",
        "Rewrite the final proposition so it is specific, believable, and testable.",
      ],
      qualityBar: [
        "Specific customer, not a broad market label.",
        "Concrete pain or desired outcome, not generic benefit language.",
        "A mechanism or proof point explaining why the proposition is believable.",
        "At least one validation test tied to a decision rule.",
      ],
    };
  }

  const domain = inferDomainLabel(brief);
  const name = sanitizeName(`${domain}-specialist`);
  const title = toTitleCase(name.replace(/-/g, " "));
  return {
    name,
    displayName: title,
    description: `Helps users reason about ${domain.replace(/-/g, " ")} and turn vague requests into usable outputs.`,
    purpose: `Help users clarify ${domain.replace(/-/g, " ")} work, structure the important assumptions, produce practical recommendations, and identify what evidence is needed before acting.`,
    skillName: sanitizeSkillName(`${domain}-method`),
    skillTitle: toTitleCase(`${domain.replace(/-/g, " ")} Method`),
    skillDescription: `Structure ${domain.replace(/-/g, " ")} work into explicit assumptions, evidence gaps, and checkable recommendations. Use when a ${domain.replace(/-/g, " ")} request arrives as a vague ambition, when the assumptions behind it need separating from the facts, or when the next useful check has to be named before acting.`,
    domain: domain.replace(/-/g, " "),
    primaryOutput:
      "a concise working brief with conclusions, assumptions, evidence gaps, and next actions",
    evidenceStandard:
      "clear user goals, explicit assumptions, grounded reasoning, and practical next steps that can be checked or tested",
    heuristics: [
      "Clarify the job before producing the answer.",
      "Separate known facts, assumptions, and open questions.",
      "Prefer concrete examples and decision criteria over generic advice.",
      "Turn uncertainty into the next useful check or action.",
    ],
    questions: [
      "What outcome should this agent help the user produce?",
      "What inputs, constraints, and standards should guide the work?",
      "What assumptions need to be checked before acting?",
      "What would a useful final answer look like?",
    ],
    workflow: [
      "Clarify the user's goal and constraints.",
      "Structure the problem into assumptions, options, and evidence gaps.",
      "Apply the domain method to produce a practical output.",
      "Flag risks, missing context, and next actions.",
    ],
    reportItems: [
      "Goal",
      "Relevant context",
      "Assumptions",
      "Recommended output",
      "Evidence gaps",
      "Next actions",
    ],
    methodSteps: [
      "Clarify the user's goal, context, and expected output.",
      "Identify assumptions, constraints, and decision criteria.",
      "Apply the domain method step by step.",
      "Produce a concise output with recommendations and open questions.",
    ],
    qualityBar: [
      "The output is specific to the user's domain and goal.",
      "Assumptions and evidence gaps are explicit.",
      "Recommendations are practical and checkable.",
    ],
  };
}

function renderInferredPersona(profile: InferredAgentProfile): string {
  return `---
name: ${profile.name}
description: ${profile.description}
thinking: medium
tools: none
---

# ${profile.displayName}

## Purpose

${profile.purpose}

## Instructions

### Identity

You are ${profile.displayName}. You are direct, practical, and evidence-minded. You help users move from vague ambition to a usable, testable proposition without hiding weak assumptions behind polished language.

### Skills

- Use \`skills/${profile.skillName}/SKILL.md\` when the task requires ${profile.domain}.

### Decision-Making Heuristics

${profile.heuristics.map((item) => `- ${item}`).join("\n")}

### Questions You Press On

${profile.questions.map((item) => `- ${item}`).join("\n")}

### Evidence Standard

You trust ${profile.evidenceStandard}. You do not treat internal enthusiasm, generic market claims, or feature lists as validation.

### Red Lines

- Do not produce generic positioning copy without naming the customer, pain, alternative, promise, and proof.
- Do not call an assumption validated unless the validation method and evidence threshold are explicit.
- Do not optimize wording before checking whether the underlying proposition is credible.

### Role Checklist

| Activity | When | How |
| --- | --- | --- |
| Clarify the customer | The target user is vague | Ask for segment, situation, trigger, and current alternative |
| Shape the proposition | The user has an offer or idea | Convert it into customer, pain, promise, proof, and differentiation |
| Validate assumptions | The claim depends on guesses | Identify riskiest assumptions and propose tests |
| Improve messaging | The proposition is coherent | Tighten the language while preserving specificity |

## Workflow

${profile.workflow.map((item, index) => `${index + 1}. ${item}`).join("\n")}

## Context

{{EXPERIENCE_BLOCK}}

{{SKILLS_BLOCK}}

{{TASK_CONTENT}}

Session: {{SESSION_ID}}

## Report

Return a concise structured report with:

${profile.reportItems.map((item) => `- ${item}`).join("\n")}
`;
}

function renderInferredSkill(
  profile: InferredAgentProfile,
  reason: string,
): string {
  return `---
name: ${profile.skillName}
description: ${profile.skillDescription}
---

# ${profile.skillTitle}

Use this skill to create, critique, or validate work in ${profile.domain}.

## Method

${profile.methodSteps.map((item, index) => `${index + 1}. ${item}`).join("\n")}

## Output Shape

${profile.reportItems.map((item) => `- ${item}`).join("\n")}

## Quality Bar

${profile.qualityBar.map((item) => `- ${item}`).join("\n")}

## Fallback Note

This skill was generated from the user's chat brief because the live architect path was unavailable: ${reason}
`;
}

function renderFallbackPersona(
  name: string,
  skills: string[],
  reason: string,
): string {
  const skillLines =
    skills.length > 0
      ? skills.map((skill) => `- \`skills/${skill}/SKILL.md\``).join("\n")
      : "- (no skills selected)";
  return `---
name: ${name}
description: Placeholder persona — generated offline because the agent architect was unavailable (${reason}).
thinking: medium
tools: none
---

# ${name}

## Purpose

(Architect offline — ${reason}. Edit this file to describe the agent's role.)

## Instructions

### Identity

You are ${name}. Replace this paragraph with the agent's identity and voice.

### Skills

${skillLines}

## Workflow

1. (replace with the agent's runtime steps)

## Context

{{EXPERIENCE_BLOCK}}

{{SKILLS_BLOCK}}

{{TASK_CONTENT}}

Session: {{SESSION_ID}}

## Report

(Describe the expected output shape.)
`;
}


function renderFallbackSkill(agentName: string, reason: string): string {
  return `---
name: ${sanitizeSkillName(`${agentName}-core`)}
description: Placeholder skill generated because the agent architect was unavailable.
---

# ${agentName} Core Skill

Use this skill as the starting point for the agent's domain method.

## Instructions

- Replace this placeholder with the concrete frameworks, checks, and output criteria this agent should use.
- Keep the skill focused on repeatable execution steps rather than persona voice.
- Architect fallback reason: ${reason}
`;
}

function latestUserBrief(history: ChatTurn[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const turn = history[index];
    if (turn?.role === "user" && turn.text.trim().length > 0) {
      return turn.text.trim();
    }
  }
  return "";
}

function inferDomainLabel(brief: string): string {
  const tokens = meaningfulTokens(brief.toLowerCase());
  const selected = tokens.slice(0, 4).join("-");
  return sanitizeName(selected || "general-purpose");
}

function meaningfulTokens(text: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "agent",
    "around",
    "build",
    "create",
    "creates",
    "creating",
    "for",
    "in",
    "is",
    "make",
    "me",
    "of",
    "on",
    "that",
    "the",
    "to",
    "with",
  ]);
  return text
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stopwords.has(token));
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractJsonBlock(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const fencedJson = fenceMatch?.[1];
  if (fencedJson) return fencedJson.trim();
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(firstBrace, i + 1);
    }
  }
  return null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Agent generation cancelled");
  error.name = "AbortError";
  throw error;
}

function skillFolderNames(skillPaths: string[]): string[] {
  const names: string[] = [];
  for (const raw of skillPaths) {
    const abs = path.resolve(raw);
    if (!fs.existsSync(path.join(abs, "SKILL.md"))) continue;
    names.push(path.basename(abs));
  }
  const unique = Array.from(new Set(names));
  unique.sort();
  return unique;
}

function readSkillBodies(
  skillPaths: string[],
): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  for (const raw of skillPaths) {
    const abs = path.resolve(raw);
    const skillMd = path.join(abs, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    try {
      const body = fs.readFileSync(skillMd, "utf8");
      results.push({ name: path.basename(abs), body });
    } catch {
      // skip unreadable skill
    }
  }
  return results;
}

function findExistingAgentWithSkills(
  repoRoot: string,
  skillNames: string[],
): string | null {
  const sortedTarget = [...skillNames].sort().join("\n");
  const agents = listAgents(repoRoot);
  for (const agent of agents) {
    const sortedExisting = [...agent.skills].sort().join("\n");
    if (sortedExisting === sortedTarget) return agent.name;
  }
  return null;
}

function sanitizeName(input: string): string {
  const trimmed = (input || "").trim().toLowerCase();
  const safe = trimmed.replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  if (safe.length === 0) return `agent-${Date.now()}`;
  if (safe.length > 40) return safe.slice(0, 40).replace(/-+$/g, "");
  return safe;
}

/**
 * Normalizes a skill name to the Agent Skills specification: lowercase
 * `a-z`, `0-9` and single hyphens, with no leading, trailing, or doubled
 * hyphens. The result also becomes the skill's folder name, and the spec
 * requires the folder name and the frontmatter `name` to match.
 */
function sanitizeSkillName(input: string): string {
  const trimmed = (input || "").trim().toLowerCase();
  const safe = trimmed
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (safe.length === 0) return `skill-${Date.now()}`;
  if (safe.length > 40) return safe.slice(0, 40).replace(/-+$/g, "");
  return safe;
}

export { sanitizeName as sanitizeAgentName, findExistingAgentWithSkills };
