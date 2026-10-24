import {
  resourceArchitectReviewSchema,
  type ResourceArchitectReview,
} from "../../contracts/schemas/resource-architect-review.js";

export type ResourceArchitectReviewParseResult =
  | { readonly ok: true; readonly review: ResourceArchitectReview }
  | { readonly ok: false; readonly error: {
    readonly kind: "extraction" | "json" | "schema";
    readonly code: "review-input-too-large" | "review-object-missing" | "review-object-truncated"
      | "review-object-ambiguous" | "review-json-invalid" | "review-schema-invalid";
  } };

const MAX_REVIEW_INPUT_LENGTH = 65_536;

/** Extract one balanced object; braces in quoted strings are ordinary evidence. */
export function parseResourceArchitectReview(text: string): ResourceArchitectReviewParseResult {
  if (text.length > MAX_REVIEW_INPUT_LENGTH) {
    return reviewParseFailure("extraction", "review-input-too-large");
  }

  let start = -1;
  let depth = 0;
  let outerArrayDepth = 0;
  let inString = false;
  let escaped = false;
  let candidate: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (depth === 0) {
      if (character === "[") outerArrayDepth += 1;
      else if (character === "]") outerArrayDepth = Math.max(0, outerArrayDepth - 1);
      if (character !== "{") continue;
      // A review nested in a collection is not the required standalone object.
      if (outerArrayDepth > 0) return reviewParseFailure("schema", "review-schema-invalid");
      // Stop after a second candidate begins; neither first-valid nor last-valid wins.
      if (candidate !== undefined) return reviewParseFailure("extraction", "review-object-ambiguous");
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) candidate = text.slice(start, index + 1);
    }
  }
  if (depth !== 0) return reviewParseFailure("extraction", "review-object-truncated");
  if (candidate === undefined) return reviewParseFailure("extraction", "review-object-missing");

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return reviewParseFailure("json", "review-json-invalid");
  }
  const validated = resourceArchitectReviewSchema.safeParse(parsed);
  return validated.success
    ? { ok: true, review: validated.data }
    : reviewParseFailure("schema", "review-schema-invalid");
}

function reviewParseFailure(
  kind: "extraction" | "json" | "schema",
  code: Extract<ResourceArchitectReviewParseResult, { ok: false }>["error"]["code"],
): ResourceArchitectReviewParseResult {
  return { ok: false, error: { kind, code } };
}
