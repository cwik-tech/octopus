export interface TeamFlowLevel {
  actorNames: string[]
  id: string
  loopLabel: string | null
  name: string
  stageType: string
}

export interface TeamFlowTransition {
  from: string
  isLoopback: boolean
  label: string
  to: string
}

export interface RunTeamFlow {
  entryLevelId: string | null
  levels: TeamFlowLevel[]
  runId: string
  team: string
  transitions: TeamFlowTransition[]
}
