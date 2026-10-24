import test from 'node:test'
import assert from 'node:assert/strict'

const dashboardCalls = {
  manageRefreshTimer: 0,
  updateDashboard: 0,
}

const stubPi = {
  registerCommand: () => {},
  appendEntry: async () => {},
  setStatusBar: () => {},
  setWidget: () => {},
} as any

test('installDashboardObserver refreshes the dashboard for matching run events', async () => {
  dashboardCalls.manageRefreshTimer = 0
  dashboardCalls.updateDashboard = 0

  const { publishEngineEvent } = await import('../../domains/runtime/runtime-events.js')
  const { createRuntimeContext } = await import('../../domains/runtime/runtime-context.js')

  const dashboardModulePath = new URL('../../team-runtime/dashboard.js', import.meta.url).href
  const originalDashboardModule = await import(dashboardModulePath)

  await (test as any).mock.module(dashboardModulePath, {
    namedExports: {
      ...originalDashboardModule,
      manageRefreshTimer: () => { dashboardCalls.manageRefreshTimer++ },
      updateDashboard: () => { dashboardCalls.updateDashboard++ },
    },
  })

  const { installDashboardObserver } = await import('../../team-runtime/runtime-observers.js')

  const ctx = createRuntimeContext(stubPi)
  ctx.lastCtx = {} as any
  ctx.teamConfig = {
    team: { name: 'writing-team', description: '', version: '1' },
    workspace: { path: '/tmp', watch: false },
    models: {},
    levels: [],
    gates: [],
    agents: [],
  } as any
  ctx.state.sessionId = 'session-match'

  const unsubscribe = installDashboardObserver(ctx)
  try {
    publishEngineEvent(undefined, {
      timestamp: new Date().toISOString(),
      category: 'agent',
      type: 'agent.start',
      run_id: 'session-match',
      payload: {},
    })

    assert.equal(dashboardCalls.manageRefreshTimer, 1)
    assert.equal(dashboardCalls.updateDashboard, 1)
  } finally {
    unsubscribe()
  }
})

test('installDashboardObserver ignores events from a different run', async () => {
  dashboardCalls.manageRefreshTimer = 0
  dashboardCalls.updateDashboard = 0

  const { publishEngineEvent } = await import('../../domains/runtime/runtime-events.js')
  const { createRuntimeContext } = await import('../../domains/runtime/runtime-context.js')
  const { installDashboardObserver } = await import('../../team-runtime/runtime-observers.js')

  const ctx = createRuntimeContext(stubPi)
  ctx.lastCtx = {} as any
  ctx.teamConfig = {
    team: { name: 'writing-team', description: '', version: '1' },
    workspace: { path: '/tmp', watch: false },
    models: {},
    levels: [],
    gates: [],
    agents: [],
  } as any
  ctx.state.sessionId = 'session-current'

  const unsubscribe = installDashboardObserver(ctx)
  try {
    publishEngineEvent(undefined, {
      timestamp: new Date().toISOString(),
      category: 'agent',
      type: 'agent.start',
      run_id: 'session-other',
      payload: {},
    })

    assert.equal(dashboardCalls.manageRefreshTimer, 0)
    assert.equal(dashboardCalls.updateDashboard, 0)
  } finally {
    unsubscribe()
  }
})

test('installDashboardObserver ignores categories outside the refresh set', async () => {
  dashboardCalls.manageRefreshTimer = 0
  dashboardCalls.updateDashboard = 0

  const { publishEngineEvent } = await import('../../domains/runtime/runtime-events.js')
  const { createRuntimeContext } = await import('../../domains/runtime/runtime-context.js')
  const { installDashboardObserver } = await import('../../team-runtime/runtime-observers.js')

  const ctx = createRuntimeContext(stubPi)
  ctx.lastCtx = {} as any
  ctx.teamConfig = {
    team: { name: 'writing-team', description: '', version: '1' },
    workspace: { path: '/tmp', watch: false },
    models: {},
    levels: [],
    gates: [],
    agents: [],
  } as any
  ctx.state.sessionId = 'session-current'

  const unsubscribe = installDashboardObserver(ctx)
  try {
    publishEngineEvent(undefined, {
      timestamp: new Date().toISOString(),
      category: 'runtime',
      type: 'runtime.event',
      run_id: 'session-current',
      payload: {},
    })

    assert.equal(dashboardCalls.manageRefreshTimer, 0)
    assert.equal(dashboardCalls.updateDashboard, 0)
  } finally {
    unsubscribe()
  }
})

test('installDashboardObserver does nothing when runtime UI context is absent', async () => {
  dashboardCalls.manageRefreshTimer = 0
  dashboardCalls.updateDashboard = 0

  const { publishEngineEvent } = await import('../../domains/runtime/runtime-events.js')
  const { createRuntimeContext } = await import('../../domains/runtime/runtime-context.js')
  const { installDashboardObserver } = await import('../../team-runtime/runtime-observers.js')

  const ctx = createRuntimeContext(stubPi)
  ctx.lastCtx = null
  ctx.teamConfig = {
    team: { name: 'writing-team', description: '', version: '1' },
    workspace: { path: '/tmp', watch: false },
    models: {},
    levels: [],
    gates: [],
    agents: [],
  } as any
  ctx.state.sessionId = 'session-current'

  const unsubscribe = installDashboardObserver(ctx)
  try {
    publishEngineEvent(undefined, {
      timestamp: new Date().toISOString(),
      category: 'agent',
      type: 'agent.start',
      run_id: 'session-current',
      payload: {},
    })

    assert.equal(dashboardCalls.manageRefreshTimer, 0)
    assert.equal(dashboardCalls.updateDashboard, 0)
  } finally {
    unsubscribe()
  }
})
