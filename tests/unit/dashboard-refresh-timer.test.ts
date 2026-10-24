/**
 * The dashboard's refresh interval, and when it may exist.
 *
 * The interval renders an animated pane every 500ms while an agent is active,
 * and it clears itself once none is. That self-clearing is the only thing that
 * ever stopped it, which leaves one gap: an agent left ACTIVE by a turn that
 * never ended keeps the interval alive forever, and any late runtime event can
 * re-arm it. `installDashboardObserver` calls `manageRefreshTimer` for six
 * event categories (`team-runtime/runtime-observers.ts:11-19`), and artifact
 * writes are published asynchronously, so events do arrive after shutdown.
 *
 * A repeating referenced interval in a runtime that has already shut down is
 * not a cosmetic problem: nothing else holds the process open at that point, so
 * the process stops exiting.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { manageRefreshTimer } from '../../team-runtime/dashboard.js'
import { createRuntimeContext } from '../../domains/runtime/runtime-context.js'
import type { RuntimeContext } from '../../domains/runtime/runtime-context.js'
import { AGENT_STATE } from '../../core/constants.js'

function contextWithActiveAgent(): RuntimeContext {
  const ctx = createRuntimeContext({
    registerTool: () => {},
  } as unknown as RuntimeContext['pi'])
  ctx.agentMetrics.set('lead', {
    state: AGENT_STATE.ACTIVE,
    rounds: 0,
    totalCost: 0,
    contextTokens: 0,
    model: 'model-a',
    color: 1,
    failureCount: 0,
  })
  // The interval renders into a captured pane, so it only arms when there is
  // one to render into.
  ctx.lastCtx = {
    ui: { setWidget: () => {}, setStatus: () => {}, notify: () => {} },
  } as unknown as RuntimeContext['lastCtx']
  return ctx
}

test('the refresh interval arms while an agent is active', () => {
  const ctx = contextWithActiveAgent()
  try {
    manageRefreshTimer(ctx)
    assert.ok(ctx.refreshTimer, 'an active agent must keep the dashboard animated')
  } finally {
    if (ctx.refreshTimer) clearInterval(ctx.refreshTimer)
  }
})

test('a shut-down runtime cannot be re-armed by a late event', () => {
  const ctx = contextWithActiveAgent()
  try {
    // Shutdown, exactly as `session_shutdown` performs it: the controller is
    // aborted and the timer is cleared (`team-runtime/index.ts:3857-3860`).
    ctx.shutdownController.abort()
    ctx.refreshTimer = null

    // A late artifact event reaches the observer and asks for the timer again.
    // The agent is still ACTIVE — the turn never ended — so the interval's own
    // self-clearing would never fire, and it would run for the life of the
    // process.
    manageRefreshTimer(ctx)

    assert.equal(
      ctx.refreshTimer,
      null,
      'an event arriving after shutdown must not restart the refresh interval',
    )
  } finally {
    if (ctx.refreshTimer) clearInterval(ctx.refreshTimer)
  }
})

test('shutdown clears an interval that is already running', () => {
  const ctx = contextWithActiveAgent()
  try {
    manageRefreshTimer(ctx)
    assert.ok(ctx.refreshTimer, 'precondition: the interval is running')

    ctx.shutdownController.abort()
    manageRefreshTimer(ctx)

    assert.equal(
      ctx.refreshTimer,
      null,
      'shutdown must stop the interval even while an agent is still marked active',
    )
  } finally {
    if (ctx.refreshTimer) clearInterval(ctx.refreshTimer)
  }
})
