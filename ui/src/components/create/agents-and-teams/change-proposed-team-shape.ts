import type { TeamShapeAmendment } from "@/lib/clients/resource-architect-client";
import type { ResourceArchitectPlan } from "@/lib/models/resource-architect-model";
import { formatDisplayName } from "@/lib/utils/display-name";
import type { TeamShape } from "@contracts/schemas/team-shape";

/**
 * Applies a shape the user picked, and says what the card should show next.
 *
 * Kept out of the chat hook so the decisions it makes are testable without a
 * React tree. There are only four outcomes and each has a different answer to
 * "what does the user now see":
 *
 * - applied: the plan carries the new shape, and the next edit is written
 *   against the revision the server just reported.
 * - someone else got there first: the card redraws from *their* shape, not the
 *   one this user picked, because that is what will actually be built.
 * - a build already holds the plan: nothing changes, and the user is told to
 *   wait rather than left wondering why the card did not move.
 * - the roles do not fit the roster: nothing changes, and the members that are
 *   wrong are named, because "someone has no role" is not actionable.
 */
export async function changeProposedTeamShape(params: {
  plan: ResourceArchitectPlan;
  shape: TeamShape;
  revision: string;
  amend: (input: {
    planId: string;
    shape: TeamShape;
    expectedRevision: string;
  }) => Promise<TeamShapeAmendment>;
}): Promise<{
  plan: ResourceArchitectPlan;
  revision: string;
  notice?: string;
  /**
   * The build this plan is admitted for, when the answer named one.
   *
   * A refusal that says "already admitted" is the authority on it, and the
   * card has to settle rather than offer the same impossible change again.
   */
  admitted?: { jobId: string; revision: string };
}> {
  const { plan, revision } = params;
  if (plan.kind !== "team") return { plan, revision };

  // The revision the card was rendered from, never one re-read just before
  // writing: re-reading would always match, and the check it is there to make
  // would never fire.
  const result = await params.amend({
    planId: plan.id,
    shape: params.shape,
    expectedRevision: revision,
  });

  if (result.ok) {
    // The plan the server now holds, not the one this card was patching. The
    // revision covers the whole record, so applying only the shape would bind
    // a fresh revision to a description and roster nobody re-read. The repair
    // flag goes with it, because the server's copy no longer carries one.
    return {
      plan: result.plan,
      revision: result.revision,
      ...(result.admitted ? { admitted: result.admitted } : {}),
    };
  }

  if (result.reason === "conflict") {
    // Redrawn from what is stored, whole. Patching one field of what the card
    // had is how a concurrent change to the roster or the description went
    // unnoticed under a revision that covered it.
    return {
      plan: result.currentPlan,
      revision: result.currentRevision,
      notice: "Someone changed this team. This is how it stands now.",
    };
  }

  if (result.reason === "admitted") {
    // Not a fault in the chosen shape: the plan has been built against, so its
    // shape is settled. The card is told which build settled it.
    return {
      plan,
      revision,
      notice: result.message,
      admitted: { jobId: result.jobId, revision: result.admittedRevision },
    };
  }

  if (result.reason === "building") {
    // A state of the plan rather than a fault in the shape, and one that ends
    // when the build does, so the server's own words are what the card shows.
    return { plan, revision, notice: result.message };
  }

  const names = result.offendingNames?.map(formatDisplayName) ?? [];
  return {
    plan,
    revision,
    notice: names.length > 0
      ? `${result.message} ${names.join(", ")}.`
      : result.message,
  };
}
