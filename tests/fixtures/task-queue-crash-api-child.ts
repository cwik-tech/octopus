import * as path from 'node:path'

import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'
import { WorkspaceDispatcherOwnerError } from '../../core/workspace-dispatcher-owner.js'

const workspacePath = process.argv[2]
if (!workspacePath) throw new Error('workspace path is required')

try {
  const realLauncher = new SessionTaskRunnerLauncher(process.cwd())
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: realLauncher,
    taskLauncher: realLauncher,
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    repoRootPath: process.cwd(),
    workflowsRegistryPath: path.join(process.cwd(), 'workflows', 'registry.yaml'),
    host: '127.0.0.1',
    port: 0,
  })
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    pid: process.pid,
    url: server.url,
  })}\n`)

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    try {
      await server.close()
      process.exit(0)
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      )
      process.exit(1)
    }
  }
  process.stdin.resume()
  process.stdin.once('data', () => void close())
  process.once('SIGTERM', () => void close())
} catch (error) {
  const code =
    error instanceof WorkspaceDispatcherOwnerError ? error.code : undefined
  await new Promise<void>((resolve) => {
    process.stdout.write(`${JSON.stringify({
      type: 'error',
      pid: process.pid,
      name: error instanceof Error ? error.name : 'Error',
      code,
      message: error instanceof Error ? error.message : String(error),
    })}\n`, () => resolve())
  })
  process.exit(code === 'workspace_in_use' ? 2 : 1)
}
