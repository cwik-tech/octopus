import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  RunTeamFlow,
  TeamFlowLevel,
  TeamFlowTransition,
} from '../contracts/team-flow.js'
import { parseTeamConfig } from '../parsers/team-config.js'
import { parseTeamRegistry } from '../parsers/team-registry.js'
import type { RunStore } from '../domains/run/run-store.js'
import type {
  DiscussionStageConfig,
  PipelineStageConfig,
  ReviewStageConfig,
  TeamConfig,
  TeamRegistryEntry,
} from '../core/types.js'

export type { RunTeamFlow, TeamFlowLevel, TeamFlowTransition }

function resolveTeamConfigPath(repoRoot: string, teamName: string): string | null {
  const registryPath = path.join(repoRoot, 'teams.yaml')
  if (fs.existsSync(registryPath)) {
    const registry = parseTeamRegistry(registryPath)
    const teamEntry = registry.entries.find(
      (entry): entry is TeamRegistryEntry => entry.type === 'team' && entry.name === teamName,
    )
    if (teamEntry?.team_path) {
      const explicitPath = path.join(teamEntry.team_path, 'team.yaml')
      if (fs.existsSync(explicitPath)) return explicitPath
    }
  }

  const fallbackPath = path.join(repoRoot, 'teams', teamName, 'team.yaml')
  return fs.existsSync(fallbackPath) ? fallbackPath : null
}

function getActorNames(level: TeamConfig['levels'][number]): string[] {
  const stage = level.stage

  if (stage.type === 'routing') {
    return [stage.coordinator]
  }

  if (stage.type === 'discussion') {
    return Array.from(new Set([stage.coordinator, ...stage.participants]))
  }

  if (stage.type === 'chain') {
    return stage.sequence
  }

  if (stage.type === 'broadcast') {
    return stage.fan_out
  }

  if (stage.type === 'review') {
    return [stage.producer, stage.reviewer]
  }

  const pipelineStage = stage as PipelineStageConfig
  return Array.from(new Set([
    ...(pipelineStage.coordinator ? [pipelineStage.coordinator] : []),
    ...(pipelineStage.participants ?? []),
  ]))
}

function getLoopLabel(level: TeamConfig['levels'][number]): string | null {
  const stage = level.stage

  if (stage.type === 'review') {
    const reviewStage = stage as ReviewStageConfig
    return reviewStage.config.max_iterations > 1
      ? `Review loop up to ${reviewStage.config.max_iterations} passes`
      : null
  }

  if (stage.type === 'discussion') {
    const discussionStage = stage as DiscussionStageConfig
    return discussionStage.config.max_rounds > 1
      ? `Discussion loop up to ${discussionStage.config.max_rounds} rounds`
      : null
  }

  return null
}

function describeTransitionLabel(transition: TeamConfig['gates'][number]): string {
  const condition = transition.condition

  if (condition.type === 'artifact_exists') {
    return condition.artifact
  }
  if (condition.type === 'validation') {
    return condition.validator
  }
  if (condition.type === 'artifact_content') {
    return condition.artifact
  }
  if (condition.type === 'agent_verdict') {
    return `${condition.validator} -> ${condition.verdict}`
  }
  if (condition.type === 'all_tasks_terminal') {
    return 'all tasks terminal'
  }
  if (condition.type === 'manual') {
    return 'manual gate'
  }

  return 'gate'
}

function buildRunTeamFlow(runId: string, teamName: string, config: TeamConfig): RunTeamFlow {
  const levels = [...config.levels]
    .sort((left, right) => left.order - right.order)
    .map((level) => ({
      actorNames: getActorNames(level),
      id: level.id,
      loopLabel: getLoopLabel(level),
      name: level.name,
      stageType: level.stage.type,
    }))

  const levelOrder = new Map(levels.map((level, index) => [level.id, index]))
  const transitions = config.gates.map((gate) => ({
    from: gate.from,
    isLoopback: gate.to !== 'done' && (levelOrder.get(gate.to) ?? Number.MAX_SAFE_INTEGER) <= (levelOrder.get(gate.from) ?? -1),
    label: describeTransitionLabel(gate),
    to: gate.to,
  }))

  return {
    entryLevelId: config.workflow?.entry_level ?? levels[0]?.id ?? null,
    levels,
    runId,
    team: teamName,
    transitions,
  }
}

export async function loadRunTeamFlow(
  store: RunStore,
  workspacePath: string,
  runId: string,
): Promise<RunTeamFlow | null> {
  const run = await store.getRun(runId)
  if (!run?.team) return null

  const repoRoot = path.dirname(workspacePath)
  const teamConfigPath = resolveTeamConfigPath(repoRoot, run.team)
  if (!teamConfigPath) return null

  const parsed = parseTeamConfig(teamConfigPath)
  if (!parsed.config) return null

  return buildRunTeamFlow(runId, run.team, parsed.config)
}
