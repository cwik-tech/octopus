import { manageRefreshTimer, updateDashboard } from './dashboard.js'
import type { RuntimeContext } from '../domains/runtime/runtime-context.js'
import { subscribeEngineEvents } from '../domains/runtime/runtime-events.js'

export function installDashboardObserver(ctx: RuntimeContext): () => void {
  return subscribeEngineEvents((event) => {
    if (!ctx.lastCtx || !ctx.teamConfig) return
    if (event.run_id && ctx.state.sessionId && event.run_id !== ctx.state.sessionId) return

    switch (event.category) {
      case 'run':
      case 'stage':
      case 'agent':
      case 'tool':
      case 'gate':
      case 'artifact':
      case 'delegation':
        manageRefreshTimer(ctx)
        updateDashboard(ctx.lastCtx, ctx)
        break
      default:
        break
    }
  })
}
