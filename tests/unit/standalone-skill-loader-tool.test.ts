import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'

import type { CapabilityDispatchEvent } from '../../contracts/capability-dispatch.js'
import { SkillLoaderCapabilityDispatchGateway } from '../../services/skill-loader-capability-adapter.js'
import { SkillLoaderService } from '../../services/skill-loader-service.js'
import { createStandaloneSkillLoaderTool } from '../../team-runtime/standalone-skill-loader-tool.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

test('standalone runtime skill loading uses the shared dispatch gateway', async (context) => {
  const repoRootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'standalone-skill-loader-'))
  context.after(async () => {
    await fs.promises.rm(repoRootPath, { recursive: true, force: true })
  })
  const skillPath = path.join(repoRootPath, 'agents', 'analyst', 'skills', 'analysis', 'SKILL.md')
  const content = '# Analysis skill\n\nFollow the evidence.\n'
  await fs.promises.mkdir(path.dirname(skillPath), { recursive: true })
  await fs.promises.writeFile(skillPath, content)
  const service = new SkillLoaderService({ repoRootPath })
  const events: CapabilityDispatchEvent[] = []
  const tool = createStandaloneSkillLoaderTool({
    dispatchInvoker: new SkillLoaderCapabilityDispatchGateway({
      dispatcher: createCapabilityTestDispatcher(events),
      service,
    }),
    getInvocationContext: () => ({
      context: {
        contractVersion: 1,
        requestId: 'standalone-skill-request',
        sessionId: 'standalone-skill-session',
        runId: 'standalone-skill-run',
        assignmentId: 'standalone-skill-assignment',
        taskId: 'standalone-skill-task',
        agentPath: 'agents/analyst',
      },
      authority: {
        kind: 'runtime-assignment',
        processIdentity: 'standalone-skill-process',
      },
    }),
  })

  assert.equal(tool.name, 'mcp__pipeline_skills__load_skill')
  const extensionContext: ExtensionToolContext = Object.create(null)
  const result = await tool.execute(
    'skill-call',
    {
      source: skillPath,
      sha256: createHash('sha256').update(content).digest('hex'),
    },
    undefined,
    undefined,
    extensionContext,
  )

  assert.equal(result.content[0]?.type, 'text')
  if (result.content[0]?.type !== 'text') assert.fail('expected text tool output')
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: true,
    name: 'analysis',
    source: skillPath,
    sha256: createHash('sha256').update(content).digest('hex'),
    content,
  })
  assert.deepEqual(
    events
      .filter((event) => event.type === 'capability.dispatch.requested')
      .map((event) => event.capabilityId),
    ['skill.load'],
  )
  assert.equal(
    events.filter((event) => event.type === 'capability.dispatch.started').length,
    1,
  )
})
