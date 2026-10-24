import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'

const workspacePath = process.argv[2]
if (!workspacePath) throw new Error('workspace path is required')

const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
process.stdout.write(`${JSON.stringify(owner.record)}\n`)
process.stdin.resume()
process.stdin.once('data', async () => {
  await owner.release()
  process.exit(0)
})
