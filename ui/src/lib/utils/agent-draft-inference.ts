import type {
  ChatTurn,
  DraftAgentResponse,
  DraftAgentSuccess,
} from "@/lib/models/agent-generator-model";

interface LocalProfile {
  name: string;
  displayName: string;
  description: string;
  purpose: string;
  skillName: string;
  skillTitle: string;
  domain: string;
  evidenceStandard: string;
  heuristics: string[];
  questions: string[];
  workflow: string[];
  reportItems: string[];
  methodSteps: string[];
  qualityBar: string[];
  sourceSkillPath?: string;
}

export function repairPlaceholderAgentDraft(
  result: DraftAgentResponse,
  chatHistory: ChatTurn[],
): DraftAgentResponse {
  if (!isPlaceholderDraft(result)) return result;
  const brief = latestUserBrief(chatHistory);

  const profile = inferLocalProfile(brief);
  return {
    ...result,
    suggestedName: profile.name,
    personaMarkdown: renderPersona(profile),
    generatedSkills: [
      {
        name: profile.skillName,
        body: renderSkill(profile),
      },
    ],
    meta: {
      model: result.meta.model,
      fallback: true,
      reason: "Repaired placeholder draft locally from chat brief.",
    },
  };
}

export function repairSkillPathsForDraft(
  skillPaths: string[],
  draft: DraftAgentSuccess,
): string[] {
  if (skillPaths.length > 0) return skillPaths;
  if (draft.meta.reason !== "Repaired placeholder draft locally from chat brief.") {
    return skillPaths;
  }
  const profile = inferLocalProfile(draft.personaMarkdown);
  return profile.sourceSkillPath ? [profile.sourceSkillPath] : skillPaths;
}

function isPlaceholderDraft(
  result: DraftAgentResponse,
): result is DraftAgentSuccess {
  if ("duplicate" in result || "needsInput" in result || "cancelled" in result) {
    return false;
  }
  if (result.generatedSkills?.length) return false;
  const text = `${result.suggestedName}\n${result.personaMarkdown}\n${result.meta.reason ?? ""}`;
  return (
    /agent-\d{8,}/.test(result.suggestedName) ||
    /Placeholder persona/i.test(text) ||
    /Replace this paragraph/i.test(text) ||
    /No valid skills selected/i.test(text)
  );
}

function inferLocalProfile(input: string): LocalProfile {
  const normalized = input.toLowerCase();
  if (/\bcustomer discovery\b|\bcustomer interviews?\b|\buser research\b/.test(normalized)) {
    return {
      name: "customer-discovery-specialist",
      displayName: "Customer Discovery Specialist",
      description:
        "Plans, conducts, and synthesizes customer discovery to validate problems, segments, and buying triggers.",
      purpose:
        "Turn vague market assumptions into interview plans, evidence standards, synthesis outputs, and clear customer learning decisions.",
      skillName: "customer-discovery-research",
      skillTitle: "Customer Discovery Research",
      domain: "customer discovery",
      evidenceStandard:
        "direct customer conversations, observed behavior, current alternatives, concrete examples, and repeated patterns in a defined segment",
      heuristics: [
        "Problem before solution: validate pain and current behavior before pitching an idea.",
        "Behavior beats preference: past actions and workarounds matter more than stated interest.",
        "Specific stories beat averages: ask about the last real occurrence, not general opinions.",
        "Segments must stay tight: patterns only matter inside a coherent customer group.",
      ],
      questions: [
        "Who exactly qualifies for discovery?",
        "What pain, workaround, or buying trigger are we testing?",
        "Which questions are leading or solution-biased?",
        "What evidence would change the next product or go-to-market decision?",
      ],
      workflow: [
        "Extract the riskiest customer, problem, and demand assumptions.",
        "Define interview segments, disqualifiers, and recruiting criteria.",
        "Draft non-leading discovery questions focused on recent behavior.",
        "Set evidence thresholds and decision rules before interviews.",
        "Synthesize patterns, contradictions, quotes, alternatives, and urgency signals.",
        "Recommend the next validation or product decision.",
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
        "Write interview questions about recent behavior instead of opinions.",
        "Add probes for alternatives, failed workarounds, decision criteria, and cost of inaction.",
        "Predefine evidence thresholds, sample size, and decision rules.",
        "Synthesize notes into repeated patterns, outliers, quotes, and invalidated assumptions.",
        "Translate findings into product, messaging, pricing, or segment decisions.",
      ],
      qualityBar: [
        "Questions are non-leading and do not pitch the solution.",
        "Each assumption has an evidence threshold and decision rule.",
        "Findings separate direct evidence from interpretation.",
        "Recommendations cite observed behavior or repeated customer stories.",
      ],
      sourceSkillPath: "skills/customer-discovery-research",
    };
  }

  if (/\bvalue propositions?\b/.test(normalized)) {
    return {
      name: "value-proposition-strategist",
      displayName: "Value Proposition Strategist",
      description:
        "Creates, sharpens, and validates customer value propositions and business assumptions.",
      purpose:
        "Turn a rough offer, product idea, or market thesis into a crisp customer value proposition with pains, outcomes, proof, differentiation, and validation tests.",
      skillName: "value-proposition-design",
      skillTitle: "Value Proposition Design",
      domain: "value proposition creation and validation",
      evidenceStandard:
        "specific customer segments, observable pains, explicit alternatives, credible proof, and assumptions that can be tested with customer conversations, landing pages, prototypes, or sales evidence",
      heuristics: [
        "Customer first: start with the specific customer, their situation, and the job they need done.",
        "Pain before promise: connect the offer to urgent pain or a meaningful desired outcome.",
        "Proof beats adjectives: replace broad claims with mechanisms, examples, and evidence.",
        "Assumptions must be testable: turn risky guesses into validation tests.",
      ],
      questions: [
        "Who is the exact customer segment and what situation triggers the need?",
        "What painful alternative do they use today?",
        "What outcome does the offer promise in plain language?",
        "Why should the customer believe the promise?",
      ],
      workflow: [
        "Restate the customer, situation, and desired outcome.",
        "Map pains, alternatives, gains, and buying triggers.",
        "Draft the core value proposition in plain language.",
        "Identify proof points, differentiators, and weak assumptions.",
        "Propose validation tests for the riskiest assumptions.",
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
        "Draft the value proposition as: For [customer] who [need/pain], this helps [outcome] by [mechanism/proof].",
        "Separate claims into known facts, plausible assumptions, and risky assumptions.",
        "Design validation tests for the riskiest assumptions, including evidence threshold and decision rule.",
      ],
      qualityBar: [
        "Specific customer, not a broad market label.",
        "Concrete pain or desired outcome, not generic benefit language.",
        "A mechanism or proof point explaining why the proposition is believable.",
        "At least one validation test tied to a decision rule.",
      ],
    };
  }

  return {
    name: "business-hypothesis-expert",
    displayName: "Business Hypothesis Expert",
    description:
      "Turns business claims into clear hypotheses, validation plans, falsification criteria, and learning decisions.",
    purpose:
      "Convert strategic guesses, startup ideas, and go-to-market claims into testable hypotheses with explicit assumptions, evidence thresholds, experiment design, and decision rules.",
    skillName: "business-hypothesis-validation",
    skillTitle: "Business Hypothesis Validation",
    domain: "business hypothesis creation and validation",
    evidenceStandard:
      "observable customer behavior, transaction signals, repeated qualitative evidence, credible market constraints, and pre-registered experiment outcomes",
    heuristics: [
      "Falsify first: design the test most likely to disprove the favorite assumption.",
      "Cheapest useful signal: pick the smallest experiment that can update the decision.",
      "Base rates matter: compare the claim with similar markets, channels, and business models.",
      "Separate belief from evidence: confidence rises only when a predefined signal appears.",
    ],
    questions: [
      "What single assumption, if false, breaks the plan?",
      "What evidence would make us stop, pivot, or double down?",
      "Which claim is about desirability, feasibility, viability, or channel access?",
      "What is the cheapest test that can produce a real signal this week?",
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
    sourceSkillPath: "skills/business-hypothesis-validation",
  };
}

/**
 * The persona this local repair writes.
 *
 * It goes to disk as the Agent's own file, so the same two rules apply here as
 * anywhere else authoring writes one: no grade, because grades are no longer
 * part of authoring, and no provider or model, because the Agent inherits the
 * one application default until somebody chooses otherwise.
 */
function renderPersona(profile: LocalProfile): string {
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

You are ${profile.displayName}. You are direct, practical, and evidence-minded. You turn vague requests into concrete work products with explicit assumptions, standards, and next decisions.

### Skills

- Use \`skills/${profile.skillName}/SKILL.md\` when the task requires ${profile.domain}.

### Decision-Making Heuristics

${profile.heuristics.map((item) => `- ${item}`).join("\n")}

### Questions You Press On

${profile.questions.map((item) => `- ${item}`).join("\n")}

### Evidence Standard

You trust ${profile.evidenceStandard}. You do not treat internal enthusiasm, generic market claims, or unsupported opinions as validation.

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

function renderSkill(profile: LocalProfile): string {
  return `---
name: ${profile.skillName}
description: Method for ${profile.domain}.
---

# ${profile.skillTitle}

Use this skill to plan, critique, or execute work in ${profile.domain}.

## Method

${profile.methodSteps.map((item, index) => `${index + 1}. ${item}`).join("\n")}

## Output Shape

${profile.reportItems.map((item) => `- ${item}`).join("\n")}

## Quality Bar

${profile.qualityBar.map((item) => `- ${item}`).join("\n")}
`;
}

function latestUserBrief(history: ChatTurn[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn?.role === "user" && turn.text.trim().length > 0) {
      return turn.text.trim();
    }
  }
  return "";
}
