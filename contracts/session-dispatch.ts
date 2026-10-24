/**
 * In `contracts/` so the renderer can describe what Send will do from the
 * same rule the server routes by. A second implementation in the interface is
 * a second router, and the two would disagree the first time either changed.
 */
import type { RunPlan } from "./run-plan.js";
import type { ChatTurnResponder } from "./sessions.js";

/**
 * What a session message is explicitly addressed to, when the client says so.
 *
 * Defined by the request schema so the wire contract and the dispatch rule can
 * never drift apart. A target is structured, never prose: the model reads the
 * text of a turn and never reads this, which is what makes an explicit order
 * unoverridable.
 */
export type { SessionMessageTarget } from "./schemas/session-requests.js";
import type { SessionMessageTarget } from "./schemas/session-requests.js";

/** Who the server decided answers this turn. */
export type SessionDispatchDecision =
  | { kind: "agents"; agentNames: string[] }
  | { kind: "general-agent" }
  | { kind: "team"; teamId: string }
  | { kind: "workflow"; workflowId: string }
  | { kind: "coordinator"; selectedWorkflowId?: string };

/**
 * Whether a persisted Workflow selection may govern an untargeted turn.
 *
 * Only a selection the user made carries that authority. A model
 * recommendation is a proposal, and a plan written before provenance existed
 * cannot prove it was anything more than one — so both read as a proposal
 * rather than as a standing instruction.
 */
export function isUserSelectedWorkflow(plan: RunPlan | null | undefined): boolean {
  return plan?.selectedWorkflow?.selectionSource === "user";
}

/**
 * The one rule that decides every turn.
 *
 * Pure on purpose: precedence is the part that must never depend on I/O
 * ordering, on which route the request arrived through, or on what a provider
 * said. An explicit target always wins, and it wins even while the selected
 * plan is active — a running Workflow does not take the conversation hostage.
 *
 * An untargeted turn belongs to the General Agent, which answers it. The
 * Coordinator keeps only the turns a Workflow the user chose is governing,
 * where the answer owed is a revised plan rather than prose.
 *
 * `admittedResponder` is replay identity, not a second router. A turn id the
 * transcript already holds was fingerprinted by whichever responder admitted
 * it, and that responder has to be the one asked again — otherwise a workflow
 * selected between the first send and the retry would silently change the
 * scheme the retry is checked against, and an ordinary retry would be refused
 * as a reused id. It is consulted only where the untargeted branch is
 * ambiguous; an explicit target names its own responder and outranks it.
 */
export function resolveSessionDispatch(input: {
  target?: SessionMessageTarget;
  plan?: RunPlan | null;
  /**
   * The responder that admitted this turn id, when the transcript holds one.
   *
   * `"coordinator"` is also what a turn recorded before the General Agent
   * existed resolves to: no earlier build could have admitted an untargeted
   * turn as anything else, so absence on a claimed turn is not ambiguity.
   */
  admittedResponder?: ChatTurnResponder;
  /**
   * Whether this deployment has the General Agent's persona installed.
   *
   * A deployment with no `agents/` directory can still hold an ordinary
   * conversation, and that has to keep being true: failing every untargeted
   * turn over a missing persona file would be a regression the front door
   * introduced. Absent reads as installed, so a pure caller reasoning about
   * precedence never has to say it.
   */
  frontDoorAvailable?: boolean;
}): SessionDispatchDecision {
  const { target } = input;
  if (target) {
    if (target.kind === "agents") {
      return { kind: "agents", agentNames: [...target.agentNames] };
    }
    if (target.kind === "team") {
      return { kind: "team", teamId: target.teamId };
    }
    return { kind: "workflow", workflowId: target.workflowId };
  }

  const selectedWorkflowId = isUserSelectedWorkflow(input.plan)
    ? input.plan?.selectedWorkflow?.id
    : undefined;

  // Ahead of the availability gate: a turn the General Agent already admitted
  // stays its turn. Sending it to the Coordinator because the persona has
  // since been removed would report a fingerprint mismatch — a reused turn id
  // — for a turn nobody reused, and hide the persona that actually went
  // missing.
  if (input.admittedResponder === "agents") return { kind: "general-agent" };
  if (
    input.frontDoorAvailable !== false &&
    selectedWorkflowId === undefined &&
    input.admittedResponder === undefined
  ) {
    return { kind: "general-agent" };
  }
  return selectedWorkflowId === undefined
    ? { kind: "coordinator" }
    : { kind: "coordinator", selectedWorkflowId };
}
