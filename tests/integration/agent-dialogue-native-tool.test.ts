import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { z } from 'zod/v4'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { AgentDialogueService } from '../../services/agent-dialogue-service.js'
import { createAgentDialogueToolAdapter } from '../../services/agent-dialogue-tool-adapter.js'
import { createDialogueFixture } from '../helpers/agent-dialogue-fixture.js'

test('a native Agent tool can correct a refused peer without creating duplicate dialogues', { timeout: 15_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const service = new AgentDialogueService({ sessionStore: fixture.store, workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath, agentTextStreamHub: fixture.hub })
  t.after(() => service.close())
  const claim = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: fixture.store.getInstanceId() }
  await fixture.store.claimSessionActivity(fixture.session.id, claim)
  const adapter = createAgentDialogueToolAdapter({ sessionId: fixture.session.id, currentAgentId: 'alpha-analyst', activity: { claim, completion: Promise.resolve(false) }, service, context: {} })
  const context = { contractVersion: MCP_RUNTIME_CONTRACT_VERSION, requestId: randomUUID(), leaseId: randomUUID(), sessionId: fixture.session.id, runId: randomUUID(), assignmentId: randomUUID(), agentPath: 'agents/alpha-analyst' } satisfies Parameters<typeof adapter.execute>[0]['context']
  const refused = await adapter.execute({ context, toolCallId: 'unknown-peer', input: { agents: ['misspelled-beta'], topic: 'Compare pricing.' } })
  assert.equal(refused.isError, true)
  assert.equal(z.object({ code: z.string() }).parse(refused.output).code, 'bad_request')
  assert.deepEqual((await fixture.store.listSessionActivityClaims(fixture.session.id)).map((entry) => entry.claimId), [claim.claimId])

  const corrected = await adapter.execute({ context, toolCallId: 'corrected-peer', input: { agents: ['beta-builder'], topic: 'Compare pricing.' } })
  assert.equal(corrected.isError, false, corrected.content)
  const record = agentDialogueRecordSchema.parse(corrected.output)
  assert.deepEqual(record.participants.map((participant) => participant.id), ['alpha-analyst', 'beta-builder'])
  const replay = await adapter.execute({ context, toolCallId: 'replayed-peer', input: { agents: ['beta-builder'], topic: 'Compare pricing.' } })
  assert.equal(replay.isError, false, replay.content)
  assert.equal(agentDialogueRecordSchema.parse(replay.output).dialogueId, record.dialogueId)
  await service.close()
  assert.equal((await service.list(fixture.session.id)).length, 1)
  assert.equal(fixture.provider.requests.length, 0)
})
