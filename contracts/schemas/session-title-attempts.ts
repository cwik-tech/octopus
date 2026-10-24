/**
 * The shape of a recorded title attempt, on the way in and on the way out.
 *
 * One schema, used by both the append and the read, because the two must agree:
 * a value the append accepts but the read cannot rebuild would make the whole
 * session unreadable on its next reload, which is worse than refusing the
 * append.
 *
 * The public type is derived from this rather than declared beside it, so the
 * validator and the type cannot drift apart.
 */
import * as z from "zod/v4";

import { readModelSelectionRecord } from "../agent-model-selection.js";

export const SESSION_TITLE_OPERATIONS = [
  "selected-agent-chat",
  "session-chat",
  "team-launch",
  "scheduled-filename",
] as const;

/**
 * An identity, kept exactly as recorded.
 *
 * These are compared, not read: trimming would make `turn-1` and ` turn-1 ` the
 * same owner, so padding is refused rather than tidied away.
 */
const exactIdentitySchema = (field: string) =>
  z
    .string({ error: `Field ${field} must be a non-empty string` })
    .refine((value) => value.length > 0 && value === value.trim(), {
      error: `Field ${field} must be a non-empty string with no surrounding whitespace`,
    });

/**
 * The only fields a title selection may carry.
 *
 * A `Set` rather than a list, so membership is asked directly of the key. The
 * earlier `find(...)` form answered the empty string for a key named `""`, and
 * an empty string is falsy — so that one unknown field passed the check and was
 * then stripped, which is exactly the silent loss this refuses.
 */
const TITLE_SELECTION_FIELDS = new Set([
  "provider",
  "model",
  "source",
  "reason",
  "caller",
]);

/**
 * The two provenances titling can actually have.
 *
 * Narrower than model selections generally, because titling owns no Agent: it
 * is the application default, or a model somebody picked for that one turn.
 * Never an Agent's own choice, and never an approved retry — nothing offers a
 * retry for a title, so a record claiming one describes something that cannot
 * have happened.
 */
const TITLE_PROVENANCES: readonly { source: string; reason: string }[] = [
  { source: "app-default", reason: "agent-default" },
  { source: "user", reason: "explicit-user-choice" },
];

/**
 * The selection this attempt was about to use.
 *
 * Delegated to `readModelSelectionRecord`, the one authority on that shape,
 * then narrowed to what titling can be. Unknown fields are refused rather than
 * dropped: a stripped value survives in the file until the next ordinary
 * metadata write persists the stripped copy, and then it is gone with nothing
 * to say it was ever there.
 */
const titleSelectionSchema = z
  .unknown()
  .transform((value, context) => {
    const refuse = (message: string) => {
      context.addIssue({ code: "custom", message });
      return z.NEVER;
    };
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return refuse("Field selection must be an object");
    }
    const unknownFields = Object.keys(value).filter(
      (key) => !TITLE_SELECTION_FIELDS.has(key),
    );
    if (unknownFields.length > 0) {
      return refuse(
        `Field selection carries ${unknownFields.length} field(s) that are not part of a title selection: ${unknownFields
          .map((field) => JSON.stringify(field))
          .join(", ")}`,
      );
    }
    const selection = readModelSelectionRecord(value);
    if (!selection) {
      return refuse("Field selection is not a complete model selection record");
    }
    if (selection.caller !== "title") {
      return refuse("Field selection.caller must be 'title'");
    }
    if (
      !TITLE_PROVENANCES.some(
        (allowed) =>
          allowed.source === selection.source && allowed.reason === selection.reason,
      )
    ) {
      return refuse(
        `Field selection names a provenance titling cannot have: ${selection.source}/${selection.reason}`,
      );
    }
    return selection;
  });

export const sessionTitleAttemptSchema = z.object(
  {
    operation: z.enum(SESSION_TITLE_OPERATIONS, {
      error: `Field operation must be one of: ${SESSION_TITLE_OPERATIONS.join(", ")}`,
    }),
    owner: exactIdentitySchema("owner"),
    attemptId: exactIdentitySchema("attemptId"),
    selection: titleSelectionSchema,
    // A real instant, not merely something `Date.parse` will take: it accepts
    // `1` and rolls `2026-02-30` forward into March, so a record could name a
    // moment that never happened.
    at: z.iso.datetime({
      offset: true,
      error: "Field at must be an ISO timestamp",
    }),
  },
  { error: "A title attempt must be an object" },
).strict();

/**
 * A whole recorded history.
 *
 * Refused whole when any entry is unreadable. Dropping the bad entries and
 * keeping the rest would let the next ordinary metadata write persist the
 * survivors, destroying the evidence that anything else was ever there.
 */
export const sessionTitleAttemptsSchema = z
  .array(sessionTitleAttemptSchema, { error: "titleAttempts must be an array" })
  .refine(
    (attempts) =>
      new Set(attempts.map((attempt) => attempt.attemptId)).size === attempts.length,
    { error: "Two title attempts may not share one attempt identity" },
  );

export type SessionTitleAttempt = z.infer<typeof sessionTitleAttemptSchema>;
export type SessionTitleOperation = SessionTitleAttempt["operation"];
