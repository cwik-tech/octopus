import { STAGE_TYPE } from '../../core/constants.js'
import type { LevelConfig } from '../../core/types.js'

interface StageEntryOptions {
  isDelegatedAutostart?: boolean
}

export function buildToolFailureFollowUp(
  levelId: string,
  toolName: string,
  coordinatorRunId: number,
  failureReason?: string,
): string {
  return (
    `Continue the team workflow from level '${levelId}'. ` +
    `The previous call to \`${toolName}\` failed in coordinator turn ${coordinatorRunId}. ` +
    `Do not claim success. Report the failure concisely using the exact tool result and stop. ` +
    (failureReason?.trim()
      ? `Use this exact failure reason directly: ${failureReason.trim()}`
      : 'If the tool result includes a specific failure reason, use that reason directly.')
  )
}

export function buildStageEntryFollowUp(
  level: LevelConfig,
  delegatedInputPath?: string,
  delegatedBrief?: string,
  options: StageEntryOptions = {},
): string {
  const levelHeader =
    `Continue the team workflow from level '${level.id}'. ` +
    `The active stage is '${level.stage.type}'.`

  const delegatedSection = delegatedInputPath
    ? `\n\nDelegated input artifact: \`${delegatedInputPath}\`.`
    : ''

  const delegatedBody = delegatedBrief?.trim()
    ? `\n\nDelegated brief:\n\n${delegatedBrief.trim()}`
    : ''

  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING:
      if (options.isDelegatedAutostart) {
        return (
          `${levelHeader}\n\n` +
          `This is a delegated workflow step. Do not ask follow-up questions or wait for approval. ` +
          `Treat the delegated brief as sufficient for this routing pass. ` +
          `Choose the best available specialist team and call \`spawn_team\` now. ` +
          `The runtime will write the job request and routing decision artifacts for you. ` +
          `After \`spawn_team\` returns, treat the tool result as authoritative: ` +
          `acknowledge success only if it succeeded; otherwise report failure and stop. ` +
          `Do not start a discussion, set a roster, or create a brief in this stage.` +
          delegatedSection +
          delegatedBody
        )
      }
      return (
        `${levelHeader}\n\n` +
        `Route this request with minimal intake. ` +
        `Ask only the missing questions needed to choose the correct team. ` +
        `If routing is already clear, call \`spawn_team\` or \`spawn_workflow\` directly and stop. ` +
        `The runtime will write the job request and routing decision artifacts for you. ` +
        `After \`spawn_team\` or \`spawn_workflow\` returns, treat the tool result as authoritative: ` +
        `acknowledge success only if it succeeded; otherwise report failure and stop. ` +
        `Do not start a discussion, set a roster, or create a brief in this stage.` +
        delegatedSection +
        delegatedBody
      )
    case STAGE_TYPE.DISCUSSION:
      return (
        `${levelHeader}\n\n` +
        `Start the discussion stage deterministically. ` +
        `Set or confirm the roster first, create the brief, then continue discussion with the stage tools.` +
        delegatedSection +
        delegatedBody
      )
    case STAGE_TYPE.PIPELINE:
      return (
        `${levelHeader}\n\n` +
        `Start the pipeline deterministically. ` +
        `Dispatch the next ready task using the pipeline tool instead of deciding a new workflow path manually.` +
        delegatedSection +
        delegatedBody
      )
    case STAGE_TYPE.CHAIN:
      return (
        `${levelHeader}\n\n` +
        `Start the chain deterministically. ` +
        `Call \`handoff\` once for this level and then stop so the runtime can manage level progression.` +
        delegatedSection +
        delegatedBody
      )
    case STAGE_TYPE.BROADCAST:
      return (
        `${levelHeader}\n\n` +
        `Start the broadcast deterministically. ` +
        `Call \`broadcast\` once for this level and then stop so the runtime can manage aggregation and progression.` +
        delegatedSection +
        delegatedBody
      )
    case STAGE_TYPE.REVIEW:
      return (
        `${levelHeader}\n\n` +
        `Start the review deterministically. ` +
        `Call \`submit_for_review\` with no arguments and then stop so the runtime can manage the review loop.` +
        delegatedSection +
        delegatedBody
      )
  }
}
