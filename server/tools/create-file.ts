import { createFileTool } from '../../services/create-file-tool-service.js'
import type { ToolModule } from './tool-registry.js'

export const createFileToolModule: ToolModule = {
  name: 'create-file',
  build(deps) {
    return {
      services: {}, routes: [],
      ...(deps.workspacePath && deps.capabilityDispatcher ? {
        agentTool: createFileTool({ workspacePath: deps.workspacePath, dispatcher: deps.capabilityDispatcher }),
        agentToolOrder: 6,
      } : {}),
    }
  },
}
