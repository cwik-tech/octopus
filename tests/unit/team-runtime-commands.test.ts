import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import { LEVEL_STATUS, STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import type { LevelConfig, TeamConfig } from '../../core/types.js'
import { createRuntimeContext } from '../../domains/runtime/runtime-context.js'
import {
  HostRunLifetime,
  type HostRunStop,
} from '../../domains/runtime/host-run-lifetime.js'
import { registerCommands } from '../../team-runtime/commands.js'

type CommandOptions = Parameters<ExtensionAPI['registerCommand']>[1]

function makeChainLevel(id: string, order: number): LevelConfig {
  return {
    id,
    name: id,
    order,
    stage: {
      type: STAGE_TYPE.CHAIN,
      sequence: [],
      config: {
        output: { format: `${id}.md`, user_review: false },
      },
    },
  }
}

function makeTeamConfig(): TeamConfig {
  return {
    team: {
      name: 'entry-team',
      description: 'Entry-level reset test.',
      version: '0.1.0',
    },
    workspace: { path: '.', watch: false },
    workflow: { entry_level: 'deliberation' },
    agents: [],
    levels: [
      makeChainLevel('warmup', 0),
      makeChainLevel('deliberation', 1),
    ],
    gates: [],
  }
}

test('team-reset reactivates the declared workflow entry level', async () => {
  const commands = new Map<string, CommandOptions['handler']>()
  const pi = {
    registerCommand(name: string, options: CommandOptions): void {
      commands.set(name, options.handler)
    },
  } as ExtensionAPI
  const ctx = createRuntimeContext(pi)
  ctx.teamConfig = makeTeamConfig()
  ctx.state.currentLevelIndex = 0
  ctx.state.levelStates.set('warmup', {
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
    engineState: null,
    loopbackCount: 2,
  })
  ctx.state.levelStates.set('deliberation', {
    status: LEVEL_STATUS.COMPLETED,
    stageStatus: STAGE_LIFECYCLE_STATUS.COMPLETED,
    engineState: null,
    loopbackCount: 1,
  })
  registerCommands(ctx, () => undefined, () => undefined, () => true, async () => true)
  const reset = commands.get('team-reset')
  assert.ok(reset)
  const notifications: string[] = []
  const extCtx = {
    ui: {
      confirm: async () => true,
      notify: (message: string) => {
        notifications.push(message)
      },
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  } as unknown as ExtensionCommandContext

  await reset('', extCtx)

  assert.equal(ctx.state.currentLevelIndex, 1)
  assert.equal(ctx.state.levelStates.get('warmup')?.status, LEVEL_STATUS.PENDING)
  assert.equal(
    ctx.state.levelStates.get('deliberation')?.status,
    LEVEL_STATUS.ACTIVE,
  )
  assert.deepEqual(notifications, ['Team reset to entry level.'])
})

test('a host whose entry never took a turn ends the run, and says so', async () => {
  // The one failure the host cannot diagnose from inside itself: Pi accepts the
  // entry and rejects it asynchronously on its own error channel. Returning
  // quietly would leave the run recorded as merely incomplete, which reads as
  // "the process stopped" rather than "this run cannot proceed".
  const commands = new Map<string, CommandOptions['handler']>()
  const pi = {
    registerCommand(name: string, options: CommandOptions): void {
      commands.set(name, options.handler)
    },
  } as ExtensionAPI
  const ctx = createRuntimeContext(pi)
  const deadline: { armed: (() => void) | null } = { armed: null }
  ctx.hostRunLifetime = new HostRunLifetime({
    work: { pendingEntryCount: () => 0, turnInFlight: () => false },
    clock: {
      setTimeout: (handler) => {
        deadline.armed = handler
        return {
          cancel: () => {
            deadline.armed = null
          },
        }
      },
    },
    keepAlive: () => ({ release: () => {} }),
    startDeadlineMs: 1_000,
  })
  const stops: Array<{ reason: string }> = []

  registerCommands(
    ctx,
    () => undefined,
    () => undefined,
    () => true,
    async () => true,
    undefined,
    (stop) => stops.push({ reason: stop.reason }),
  )
  const handler = commands.get('team-host-run')
  assert.ok(handler, 'the host must register the command it is launched with')

  ctx.hostRunLifetime.entryDelivered()
  const running = handler('', {} as ExtensionCommandContext)
  assert.ok(deadline.armed, 'a delivered entry must be given a deadline to start its turn')
  deadline.armed()
  await running

  assert.deepEqual(stops, [{ reason: 'entry_never_started' }])
})

test('a host that simply ran out of work reports no failure', async () => {
  const commands = new Map<string, CommandOptions['handler']>()
  const pi = {
    registerCommand(name: string, options: CommandOptions): void {
      commands.set(name, options.handler)
    },
  } as ExtensionAPI
  const ctx = createRuntimeContext(pi)
  ctx.hostRunLifetime = new HostRunLifetime({
    work: { pendingEntryCount: () => 0, turnInFlight: () => false },
    clock: { setTimeout: () => ({ cancel: () => {} }) },
    keepAlive: () => ({ release: () => {} }),
    startDeadlineMs: 1_000,
  })
  const stops: Array<{ reason: string }> = []

  registerCommands(
    ctx,
    () => undefined,
    () => undefined,
    () => true,
    async () => true,
    undefined,
    (stop) => stops.push({ reason: stop.reason }),
  )
  const handler = commands.get('team-host-run')
  assert.ok(handler)
  await handler('', {} as ExtensionCommandContext)

  assert.deepEqual(stops, [{ reason: 'no_work_remains' }])
})

test('a host that gave up on an entry it could never dispatch reports that as a failure', async () => {
  // Not an ordinary quiet end: no coordinator ran, the run has not done its
  // work, and nothing else in the process will say so.
  const commands = new Map<string, CommandOptions['handler']>()
  const pi = {
    registerCommand(name: string, options: CommandOptions): void {
      commands.set(name, options.handler)
    },
  } as ExtensionAPI
  const ctx = createRuntimeContext(pi)
  ctx.hostRunLifetime = new HostRunLifetime({
    work: { pendingEntryCount: () => 1, turnInFlight: () => false },
    clock: { setTimeout: () => ({ cancel: () => {} }) },
    keepAlive: () => ({ release: () => {} }),
    startDeadlineMs: 1_000,
  })
  const stops: HostRunStop[] = []

  registerCommands(
    ctx,
    () => undefined,
    () => undefined,
    () => true,
    async () => true,
    undefined,
    (stop) => stops.push(stop),
  )
  const handler = commands.get('team-host-run')
  assert.ok(handler)

  const running = handler('', {} as ExtensionCommandContext)
  ctx.hostRunLifetime.dispatchAbandoned('admission_unrecordable')
  await running

  assert.deepEqual(stops, [
    { reason: 'entry_never_dispatched', detail: 'admission_unrecordable' },
  ])
})
