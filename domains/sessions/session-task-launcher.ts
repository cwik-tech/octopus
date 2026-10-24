import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { RunLaunchResult, RunStartRequest } from '../run/run-store.js'
import { launchDetachedProcess, type RunLauncher } from '../run/run-launcher.js'
import { PROCESS_IDENTITY_ARGUMENT } from './task-process-supervisor.js'
import { CONFIGURED_PROVIDER_BROKER_URL_ENV } from '../provider/provider-settings.js'
import { configuredProviderBrokerIdentity } from './provider-broker-identity.js'

export { PROCESS_IDENTITY_ARGUMENT } from './task-process-supervisor.js'

export interface SessionTaskRunnerLauncherOptions {
  /**
   * Told when a runner this launcher started has ended (its `close`), or its
   * launch failed. A failed launch can report both its error and its close,
   * so the callee is expected to be idempotent.
   */
  readonly onRelease?: () => void
}

export class SessionTaskRunnerLauncher implements RunLauncher {
  constructor(
    private readonly repoRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    private readonly options: SessionTaskRunnerLauncherOptions = {},
  ) {}

  async startRun(request: RunStartRequest): Promise<RunLaunchResult> {
    const runnerEntry = path.join(this.repoRootPath, 'domains', 'sessions', 'session-task-runner.ts')
    const tsxEntry = createRequire(import.meta.url).resolve('tsx/cli')
    const identityArguments = request.processIdentity
      ? ['--', `${PROCESS_IDENTITY_ARGUMENT}${request.processIdentity}`]
      : []
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...request.env,
      TEAM_RUNTIME_START_SERVICES: '0',
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    }
    const brokerIdentity = configuredProviderBrokerIdentity(
      environment[CONFIGURED_PROVIDER_BROKER_URL_ENV],
    )
    const pid = await launchDetachedProcess({
      command: process.execPath,
      args: [tsxEntry, runnerEntry, ...identityArguments],
      options: {
        cwd: request.cwd,
        env: environment,
        detached: true,
        stdio: 'ignore',
      },
      ...(this.options.onRelease ? { onRelease: this.options.onRelease } : {}),
    })

    return {
      launched: true,
      pid,
      processGroupId: pid,
      ...(brokerIdentity
        ? { configuredProviderBrokerIdentity: brokerIdentity }
        : {}),
      ...(request.processIdentity
        ? { processIdentity: request.processIdentity }
        : {}),
      cwd: request.cwd,
    }
  }
}
