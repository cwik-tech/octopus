import type { RunLauncher } from '../run/run-launcher.js'
import type { RunLaunchResult, RunStartRequest } from '../run/run-store.js'
import { MCP_WORKER_TURN_URL_ENV } from './mcp-worker-turn.js'

export interface WorkerEndpointEnvironmentEntry {
  readonly environmentVariable: string
  readonly url?: string
}

/** Inject the private worker endpoint only into Run-Orchestrator task trees. */
export class McpWorkerTurnRunLauncher implements RunLauncher {
  constructor(
    private readonly delegate: RunLauncher,
    private readonly workerTurnUrl: () => string | undefined,
    private readonly endpointEnvironment: () =>
      readonly WorkerEndpointEnvironmentEntry[] = () => [],
  ) {}

  startRun(request: RunStartRequest): Promise<RunLaunchResult> {
    const workerTurnUrl = this.workerTurnUrl()?.trim()
    if (!workerTurnUrl) {
      throw new Error('MCP worker bridge is unavailable for this task run.')
    }
    const endpointEnvironment = Object.fromEntries(
      this.endpointEnvironment().flatMap((entry) => {
        const url = entry.url?.trim()
        return url ? [[entry.environmentVariable, url]] : []
      }),
    )
    return this.delegate.startRun({
      ...request,
      env: {
        ...request.env,
        ...endpointEnvironment,
        [MCP_WORKER_TURN_URL_ENV]: workerTurnUrl,
      },
    })
  }
}
