import { z } from 'zod'

/**
 * How the members of a generated team work together.
 *
 * The user never sees the words "stage type". They see a sentence — "they hand
 * work to each other", "they take turns discussing it", "one drafts, another
 * checks it" — and this is what that sentence compiles to.
 *
 * Derived from the schema rather than declared beside it, so the wire form and
 * the type cannot drift. Roles are flattened onto each variant rather than
 * nested under a second discriminator, which would let `kind` and the role set
 * disagree while still type-checking.
 *
 * The decision is `docs/adr/2026-09-14-Team-Interaction-Shapes.md`.
 */

const trimmed = z.string().trim().min(1)

/** How hard the team works at it. Bounded — "until they converge" is not offered. */
export const teamShapeDepthSchema = z.enum(['quick', 'standard', 'thorough'])

export type TeamShapeDepth = z.infer<typeof teamShapeDepthSchema>

export const teamShapeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chain'),
    rationale: trimmed,
    depth: teamShapeDepthSchema,
    /** Roster names in run order. The last one owns the deliverable. */
    order: z.array(trimmed).min(1),
  }),
  z.object({
    kind: z.literal('discussion'),
    rationale: trimmed,
    depth: teamShapeDepthSchema,
    coordinator: trimmed,
    // All eligible specialists. Team Chat's lead selects a bounded group from
    // this roster for the conversation; that limit does not cap team membership.
    participants: z.array(trimmed).min(1),
  }),
  z.object({
    kind: z.literal('review'),
    rationale: trimmed,
    depth: teamShapeDepthSchema,
    producer: trimmed,
    reviewer: trimmed,
  }),
])

export type TeamShape = z.infer<typeof teamShapeSchema>

export type TeamShapeKind = TeamShape['kind']

/**
 * How many rounds each depth buys.
 *
 * `minRounds` is always 1. The engine reads it only in Team Chat
 * (`engines/discussion.ts:361`), so offering a range in the UI would be
 * decorative in a workflow run.
 */
export function depthRounds(depth: TeamShapeDepth): {
  rounds: number
  minRounds: number
} {
  switch (depth) {
    case 'quick':
      return { rounds: 1, minRounds: 1 }
    case 'standard':
      return { rounds: 3, minRounds: 1 }
    case 'thorough':
      return { rounds: 5, minRounds: 1 }
  }
}

/** Why a proposed shape cannot be applied to this roster. */
export interface ShapeRosterRejection {
  ok: false
  reason: string
  offendingNames?: string[]
}

export type ShapeRosterVerdict = { ok: true } | ShapeRosterRejection

function sorted(names: Iterable<string>): string[] {
  return [...new Set(names)].sort()
}

/**
 * Whether a shape's roles partition this roster, one role per member.
 *
 * The rule is a partition, not "the names are non-empty". A shape that leaves a
 * member out gives that member nothing to do, and one that names an outsider
 * would emit a team.yaml referring to an agent that is not on the roster.
 * Either way the offending names are returned so the caller can say which.
 */
export function validateShapeAgainstRoster(
  shape: TeamShape,
  roster: readonly string[],
): ShapeRosterVerdict {
  const members = new Set(roster)

  switch (shape.kind) {
    case 'chain': {
      const outsiders = shape.order.filter((name) => !members.has(name))
      if (outsiders.length > 0) {
        return {
          ok: false,
          reason: 'Every name in the order must be on the roster.',
          offendingNames: sorted(outsiders),
        }
      }
      return partition([shape.order], roster, 'Every team member must appear in exactly one role.')
    }

    case 'discussion': {
      if (roster.length < 2) {
        return {
          ok: false,
          reason: 'A discussion needs at least two team members.',
        }
      }
      const named = [shape.coordinator, ...shape.participants]
      const outsiders = named.filter((name) => !members.has(name))
      if (outsiders.length > 0) {
        return {
          ok: false,
          reason: 'Every name in the discussion must be on the roster.',
          offendingNames: sorted(outsiders),
        }
      }
      return partition(
        [[shape.coordinator], shape.participants],
        roster,
        'Every team member must appear in exactly one role.',
      )
    }

    case 'review': {
      if (shape.producer === shape.reviewer) {
        return {
          ok: false,
          reason: 'The writer and the checker must be different team members.',
          offendingNames: [shape.producer],
        }
      }
      const named = [shape.producer, shape.reviewer]
      const outsiders = named.filter((name) => !members.has(name))
      if (outsiders.length > 0) {
        return {
          ok: false,
          reason: 'Every name in the review must be on the roster.',
          offendingNames: sorted(outsiders),
        }
      }
      // A review stage carries no membership list, so a third agent is inert:
      // it would sit on the roster and never run. Refuse rather than mislead.
      const spare = roster.filter((name) => !named.includes(name))
      if (spare.length > 0) {
        return {
          ok: false,
          reason: 'A review team is one writer and one checker.',
          offendingNames: sorted(spare),
        }
      }
      return { ok: true }
    }
  }
}

/**
 * Whether the role lists cover every roster member exactly once.
 *
 * Reports both halves of the failure together — members with no role, and
 * members holding two — because a user shown only one half fixes it and hits
 * the other.
 */
function partition(
  roleLists: readonly (readonly string[])[],
  roster: readonly string[],
  reason: string,
): ShapeRosterVerdict {
  const counts = new Map<string, number>()
  for (const list of roleLists) {
    for (const name of list) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const offending = [
    ...roster.filter((name) => (counts.get(name) ?? 0) !== 1),
    ...[...counts.keys()].filter((name) => (counts.get(name) ?? 0) > 1),
  ]
  if (offending.length === 0) return { ok: true }
  return { ok: false, reason, offendingNames: sorted(offending) }
}

/**
 * The same contract, in the dialect the provider answers against.
 *
 * Generated from `teamShapeSchema` rather than written beside it. A
 * hand-written copy is a second authority that can disagree with the first,
 * and the disagreement shows up as a model answer the app then rejects.
 *
 * One transform is applied. Zod renders a discriminated union as `oneOf`,
 * while `resource-architect-output-schema.ts` is `anyOf` throughout. The two
 * are equivalent here — the branches are discriminated by a `const` `kind`, so
 * at most one can ever match — and staying in the shipped dialect avoids
 * betting on a provider accepting a keyword nothing in this app has sent it.
 *
 * The generated document's `$schema` is left behind rather than carried: this
 * is embedded in a larger schema document, not served as one.
 */
export function teamShapeProviderSchema(): Record<string, unknown> {
  return { anyOf: teamShapeProviderBranches() }
}

/**
 * The three shape branches on their own.
 *
 * Exposed separately so a caller can add a `{ type: "null" }` alternative
 * beside them. Nesting one `anyOf` inside another would work, but the shipped
 * output schema spells a nullable field as one flat list of alternatives, and
 * a schema the provider rejects costs a whole plan.
 */
export function teamShapeProviderBranches(): Record<string, unknown>[] {
  const generated: unknown = z.toJSONSchema(teamShapeSchema, { target: 'draft-7' })
  // Checked rather than asserted. Zod's own type does not promise `oneOf`, and
  // a version that stopped emitting it would otherwise reach the provider as a
  // schema with no branches at all — which fails at the API boundary, costing
  // a whole plan, rather than here.
  const branches =
    generated && typeof generated === 'object' && 'oneOf' in generated
      ? generated.oneOf
      : undefined
  if (!isRecordArray(branches)) {
    throw new Error('The team shape schema did not render as a union of branches.')
  }
  return branches
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    )
  )
}
