import type { TeamShape, TeamShapeKind } from "@contracts/schemas/team-shape";
import { formatDisplayName } from "@/lib/utils/display-name";

/** Named roles from the executable shape, never inferred from persona names. */
export function shapeAssignmentRoles(shape: TeamShape): string {
  if (shape.kind === "discussion") {
    return `Lead: ${formatDisplayName(shape.coordinator)}. Receives the assignment and guides the discussion.`;
  }
  if (shape.kind === "review") {
    return `Writer: ${formatDisplayName(shape.producer)}. Checker: ${formatDisplayName(shape.reviewer)}. No separate lead.`;
  }
  return `Starts with: ${formatDisplayName(shape.order[0] ?? "")}. Final result: ${formatDisplayName(shape.order.at(-1) ?? "")}. No separate lead.`;
}

/**
 * What a team's interaction shape is called in front of the person who asked
 * for it.
 *
 * `routing`, `discussion`, `pipeline`, `chain`, `broadcast` and `review` are
 * the engine's vocabulary. Someone who has just described a problem cannot
 * choose between those words, so the UI never shows them. Every string here is
 * an outcome the user can recognise, and the mapping to a stage type happens
 * out of sight.
 */
export function shapeHeadline(kind: TeamShapeKind): string {
  switch (kind) {
    case "chain":
      return "Each builds on the last";
    case "discussion":
      return "They take turns discussing it";
    case "review":
      return "One drafts, another checks it before it counts";
  }
}

/**
 * How far the team may go, phrased as agency rather than repetition.
 *
 * Deliberately not "3 rounds". In a workflow run the engine loops to the
 * ceiling unattended; in Team Chat the lead drives each further pass and the
 * user watches. Nothing anywhere detects convergence, so no wording here may
 * suggest the team stops when it has settled.
 */
export function depthSentence(shape: TeamShape): string {
  // A chain has no rounds to describe. `renderStageBody` writes no depth for
  // one and `engines/chain.ts` runs the sequence once, so any wording about
  // going back and forth would describe a team the build does not produce.
  if (shape.kind === "chain") return "Each agent works once, in order";
  switch (shape.depth) {
    case "quick":
      return "One pass each";
    case "standard":
      return "They go back and forth a few times";
    case "thorough":
      return "They go back and forth up to five times";
  }
}

/**
 * What this shape saves, when the two run modes save different things.
 *
 * Only a discussion differs: a workflow run writes the transcript, Team Chat
 * writes the lead's synthesis. A user who gets minutes from one path and a
 * summary from the other will think something is broken, so the card says so
 * rather than leaving them to find out.
 */
export function shapeOutputNote(shape: TeamShape): string | null {
  return shape.kind === "discussion"
    ? "A workflow run saves the full discussion; a chat run saves the summary."
    : null;
}

/**
 * The members a shape names, in the order it names them.
 *
 * For a *saved* team's shape this is the whole membership: such a shape is only
 * reported when it accounts for the team's roster exactly once, so the names are
 * complete even when some of them are kept out of the interface. For a proposal
 * that has not been saved it is only what that proposal happens to say, which is
 * why the chooser keeps taking its roster from its caller rather than from here.
 */
export function shapeRoleNames(shape: TeamShape): string[] {
  if (shape.kind === "chain") return [...shape.order];
  if (shape.kind === "discussion") {
    return [shape.coordinator, ...shape.participants];
  }
  return [shape.producer, shape.reviewer];
}

/**
 * The roster in the order the shape will actually run it.
 *
 * The plan lists existing agents then new ones, which is about where each came
 * from and not about what the team does. Showing that order beside a chain that
 * runs a different one is a plain contradiction, and the emitter now writes the
 * chosen order into the file, so the card has to show the same thing.
 *
 * Names the shape does not mention keep their relative position at the end,
 * which is what a roster still being assembled looks like.
 */
export function rosterInShapeOrder(
  roster: readonly string[],
  shape: TeamShape | undefined,
): string[] {
  if (!shape) return [...roster];
  // Ranks only. What comes back is the supplied roster reordered, so a name
  // the caller did not supply is never introduced here.
  const ranked = new Map(shapeRoleNames(shape).map((name, index) => [name, index]));
  return [...roster].sort((left, right) => {
    const leftRank = ranked.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = ranked.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return roster.indexOf(left) - roster.indexOf(right);
  });
}

/**
 * Whether each position should be numbered.
 *
 * Only a chain hands work along in sequence, so only a chain's positions are a
 * count. A discussion's order changes what each agent reads but not who writes
 * the deliverable, and a review has no order at all.
 */
export function rosterIsNumbered(shape: TeamShape | undefined): boolean {
  return shape?.kind === "chain";
}

/** What the card says about why a discussion's order is shown. */
export function rosterOrderNote(shape: TeamShape | undefined): string | null {
  return shape?.kind === "discussion"
    ? "They speak in the order shown, and later ones can see earlier replies."
    : null;
}
