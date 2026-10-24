/**
 * The registry reading behind the front door's catalog.
 *
 * Separated from the rendering so the shape of the block can be asserted
 * without a repository on disk, and so this file is the only place that knows
 * where Teams and Workflows are registered.
 */

import { listPublishedTeams } from "../domains/agent-generator/index.js";
import {
  renderFrontDoorCatalog,
  type FrontDoorTeam,
  type FrontDoorWorkflow,
} from "../domains/sessions/front-door.js";
import { listWorkflowEntriesForPlanning } from "./run-orchestrator-service.js";

/**
 * What the front door may propose, as it stands right now.
 *
 * Eligibility is borrowed, not restated. Teams are filtered the way the Team
 * picker filters them, and Workflows the way the Coordinator's planning list
 * does — internal wrappers and templates that would fail launch validation are
 * both out. A suggestion the user cannot act on is worse than no suggestion:
 * the reply names something the picker does not have, and the reader has no
 * way to tell it is wrong.
 *
 * A registry that cannot be read renders as an empty catalog rather than
 * failing the turn. Losing the suggestion is a far smaller failure than losing
 * the answer.
 */
export function buildFrontDoorCatalog(input: {
  repoRootPath: string;
  workflowsRegistryPath?: string;
}): string {
  let teams: FrontDoorTeam[] = [];
  try {
    // Published only: the front door offers what a user can actually run.
    teams = listPublishedTeams(input.repoRootPath)
      .filter((team) => team.userInvocable !== false)
      .map((team) => ({
        id: team.id,
        ...(team.description ? { description: team.description } : {}),
      }));
  } catch {
    teams = [];
  }

  let workflows: FrontDoorWorkflow[] = [];
  try {
    workflows = listWorkflowEntriesForPlanning({
      repoRootPath: input.repoRootPath,
      ...(input.workflowsRegistryPath
        ? { workflowsRegistryPath: input.workflowsRegistryPath }
        : {}),
    }).map((workflow) => ({
      id: workflow.id,
      ...(workflow.description ? { description: workflow.description } : {}),
    }));
  } catch {
    workflows = [];
  }

  return renderFrontDoorCatalog({ teams, workflows });
}
