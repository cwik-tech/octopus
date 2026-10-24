/**
 * Dormant legacy deterministic workflow-matching primitives.
 *
 * These functions are not an active semantic selector for Run chat or
 * `spawn_workflow`. LLM-selected workflow ids are validated exactly by the
 * runtime. The matcher remains tested and available only for a possible future
 * offline fallback or retrieval-shortlisting layer; restoring it as a final
 * selector requires an explicit architecture decision.
 */
import { significantTextTokens } from "./text-tokens.js";

export interface WorkflowMatchCandidate {
  id: string;
  description?: string;
  tags?: string[];
  capabilities?: string[];
}

export interface ScoredWorkflowMatch<T extends WorkflowMatchCandidate> {
  workflow: T;
  score: number;
  matchedTokens: string[];
}

export function significantWorkflowTokens(text: string): string[] {
  return significantTextTokens(text);
}

export function rankWorkflowMatches<T extends WorkflowMatchCandidate>(
  workflows: readonly T[],
  goal: string,
): ScoredWorkflowMatch<T>[] {
  const goalTokens = significantWorkflowTokens(goal);
  const normalizedGoal = normalizeTokenPhrase(goal);
  return workflows
    .map((workflow) => {
      const tokenWeights = new Map<string, number>();
      addTokenWeights(tokenWeights, workflow.id, 5);
      for (const tag of workflow.tags ?? []) addTokenWeights(tokenWeights, tag, 4);
      for (const capability of workflow.capabilities ?? []) {
        addTokenWeights(tokenWeights, capability, 3);
      }
      addTokenWeights(tokenWeights, workflow.description ?? "", 1);

      const matchedTokens = goalTokens.filter((token) => tokenWeights.has(token));
      let score = matchedTokens.reduce(
        (total, token) => total + (tokenWeights.get(token) ?? 0),
        0,
      );
      const normalizedId = normalizeTokenPhrase(workflow.id);
      if (normalizedId && containsExactPhrase(normalizedGoal, normalizedId)) {
        score += 8;
      }
      return { workflow, score, matchedTokens };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.workflow.id.localeCompare(right.workflow.id),
    );
}

export function hasClearWorkflowMatch<T extends WorkflowMatchCandidate>(
  scored: readonly ScoredWorkflowMatch<T>[],
  minimumScore = 3,
): boolean {
  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score < minimumScore) return false;
  if (!runnerUp || runnerUp.score === 0) return true;
  const requiredMargin = Math.max(2, Math.ceil(best.score * 0.2));
  return best.score - runnerUp.score >= requiredMargin;
}

function addTokenWeights(
  target: Map<string, number>,
  text: string,
  weight: number,
): void {
  for (const token of significantWorkflowTokens(text)) {
    target.set(token, Math.max(target.get(token) ?? 0, weight));
  }
}

function normalizeTokenPhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsExactPhrase(text: string, phrase: string): boolean {
  return text === phrase || text.startsWith(`${phrase} `) ||
    text.endsWith(` ${phrase}`) || text.includes(` ${phrase} `);
}
