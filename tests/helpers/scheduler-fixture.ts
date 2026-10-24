import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { validateWorkflowForLaunch } from '../../services/run-orchestrator-service.js'

export interface SchedulerFixture {
  readonly repoRootPath: string
  readonly workspacePath: string
  readonly workflowsRegistryPath: string
  readonly workflowId: string
  readonly agentName: string
  cleanup(): void
}

export function createSchedulerFixture(prefix = 'scheduler-fixture-'): SchedulerFixture {
  const repoRootPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const agentName = 'test-agent'
  const teamId = 'test-team'
  const workflowId = 'test-workflow'
  const workspacePath = path.join(repoRootPath, 'workspace')
  const workflowsRegistryPath = path.join(repoRootPath, 'workflows', 'registry.yaml')
  fs.mkdirSync(workspacePath, { recursive: true })

  write(
    path.join(repoRootPath, 'agents', agentName, `${agentName}.md`),
    [
      '---',
      'name: Test Agent',
      'description: Agent used by scheduler integration tests.',
      'tier: execution',
      'provider: openai',
      'model: gpt-5-mini',
      '---',
      '',
      'Produce the requested test result.',
      '',
    ].join('\n'),
  )
  write(
    path.join(repoRootPath, 'teams', teamId, 'team.yaml'),
    [
      'team:',
      `  name: ${teamId}`,
      '  description: Scheduler test team.',
      "  version: '0.1.0'",
      '',
      'workflow:',
      '  entry_level: run',
      '  invocation_modes:',
      '    - team',
      '  user_facing: false',
      '  output_contract:',
      '    artifacts:',
      '      - path: result.md',
      '        required: true',
      '    completion_artifact: result.md',
      '',
      'agents:',
      `  - name: ${agentName}`,
      '    type: agent',
      '    role: Execute the scheduler test.',
      '    tier: execution',
      `    agent_file: ../../agents/${agentName}/${agentName}.md`,
      '    produces:',
      '      - path: result.md',
      '',
      'levels:',
      '  - id: run',
      '    name: Run',
      '    order: 0',
      '    stage:',
      '      type: chain',
      '      sequence:',
      `        - ${agentName}`,
      '',
    ].join('\n'),
  )
  write(
    path.join(repoRootPath, 'teams.yaml'),
    [
      `${teamId}:`,
      '  type: team',
      '  description: Scheduler test team.',
      `  team_path: ./teams/${teamId}`,
      '  input_artifact: incoming-brief.md',
      '  output_artifact: result.md',
      '',
    ].join('\n'),
  )
  write(
    path.join(repoRootPath, 'workflows', 'user-generated', `${workflowId}.yaml`),
    [
      'workflow:',
      `  id: ${workflowId}`,
      '  description: Visible workflow used by scheduler tests.',
      '  input:',
      '    artifact: incoming-brief.md',
      '  steps:',
      '    - id: run-test-agent',
      '      type: agent',
      `      team: ${teamId}`,
      `      agent: ${agentName}`,
      '      stage_type: chain',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: result.md',
      "      requested_result_type: 'artifact:result.md'",
      '  output:',
      '    from_step: run-test-agent',
      '    artifact: result.md',
      '  on_blocked: stop',
      '  on_failed: stop',
      '',
    ].join('\n'),
  )
  write(
    workflowsRegistryPath,
    [
      `${workflowId}:`,
      '  description: Visible workflow used by scheduler tests.',
      `  template_path: ./user-generated/${workflowId}.yaml`,
      '  tags:',
      '    - test',
      '',
    ].join('\n'),
  )

  const validationErrors = validateWorkflowForLaunch({
    repoRootPath,
    workflowsRegistryPath,
    workflowId,
  })
  if (validationErrors.length > 0) {
    fs.rmSync(repoRootPath, { recursive: true, force: true })
    throw new Error(`Scheduler fixture is invalid: ${validationErrors.join('; ')}`)
  }

  return {
    repoRootPath,
    workspacePath,
    workflowsRegistryPath,
    workflowId,
    agentName,
    cleanup: () => fs.rmSync(repoRootPath, { recursive: true, force: true }),
  }
}

function write(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents, 'utf8')
}
