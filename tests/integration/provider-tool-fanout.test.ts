import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  runProviderToolLoop,
  type ProviderToolDefinition,
} from '../../domains/provider/provider-tool-loop.js'
import type { CapabilityDispatchEvent } from '../../contracts/capability-dispatch.js'
import {
  SkillLoaderCapabilityDispatchGateway,
  type SkillLoaderCapabilityDispatchInput,
} from '../../services/skill-loader-capability-adapter.js'
import {
  SkillLoaderService,
  type LoadSkillOutput,
} from '../../services/skill-loader-service.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

test('concurrent governed skill loads through the provider loop match sequential results', async (context) => {
  const repoRootPath = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'provider-skill-fanout-'),
  )
  context.after(async () => {
    await fs.promises.rm(repoRootPath, { recursive: true, force: true })
  })
  const skills = makeSkillCatalog(repoRootPath, ['analysis', 'review'])
  const events: CapabilityDispatchEvent[] = []
  const dispatcher = createCapabilityTestDispatcher(events)
  const service = new SkillLoaderService({ repoRootPath })
  const gateway = new SkillLoaderCapabilityDispatchGateway({
    dispatcher,
    service,
  })

  const concurrent = await runSkillFanoutTurn(gateway, service, skills, 'c', {
    pool: undefined,
  })
  const sequential = await runSkillFanoutTurn(gateway, service, skills, 's', {
    pool: 1,
  })

  assert.ok(
    concurrent.overlapped,
    `the two governed skill loads must overlap in one turn, observed: ${concurrent.trace.join(',')}`,
  )
  assert.ok(
    !sequential.overlapped,
    `the pool-1 twin must not overlap, observed: ${sequential.trace.join(',')}`,
  )
  // Keyed by call index, never by settle order: the concurrent turn's settle
  // order is nondeterministic, so comparing completion-ordered arrays would
  // assert on scheduling noise rather than on output equivalence.
  assert.deepEqual(concurrent.outputsByCallIndex, sequential.outputsByCallIndex)
  // The loop's own ordering guarantee: tool messages follow call order even
  // when a later call settles first.
  assert.deepEqual(concurrent.toolMessageNames, sequential.toolMessageNames)
  assert.deepEqual(concurrent.toolMessageNames, [...skills.keys()])
  for (const output of Object.values(concurrent.outputsByCallIndex)) {
    assert.equal(output.ok, true)
  }
  const started = events.filter(
    (event) => event.type === 'capability.dispatch.started',
  )
  const completed = events.filter(
    (event) => event.type === 'capability.dispatch.completed',
  )
  assert.equal(started.length, 4)
  assert.equal(completed.length, 4)
})

interface SkillFanoutResult {
  readonly overlapped: boolean
  readonly trace: readonly string[]
  readonly outputsByCallIndex: Readonly<Record<number, LoadSkillOutput>>
  readonly toolMessageNames: readonly string[]
}

async function runSkillFanoutTurn(
  gateway: SkillLoaderCapabilityDispatchGateway,
  service: SkillLoaderService,
  skills: ReadonlyMap<string, { readonly source: string; readonly sha256: string; readonly content: string }>,
  turnLabel: string,
  options: { readonly pool: number | undefined },
): Promise<SkillFanoutResult> {
  const trace: string[] = []
  const names = [...skills.keys()]
  const toolDefinition: ProviderToolDefinition = {
    name: service.tool.namespacedName,
    description: service.tool.description ?? 'Load one skill.',
    inputSchema: service.tool.inputSchema,
    effect: service.tool.effect,
  }
  const dispatch = (
    toolCallId: string,
    marker: string,
  ): SkillLoaderCapabilityDispatchInput => {
    const skill = skills.get(marker)
    assert.ok(skill)
    return {
      context: {
        contractVersion: 1,
        requestId: `fanout-${toolCallId}`,
        sessionId: 'skill-fanout-session',
        runId: 'skill-fanout-run',
        assignmentId: `skill-fanout-assignment-${turnLabel}`,
        agentPath: 'agents/analyst',
      },
      authority: { kind: 'runtime-assignment', processIdentity: 'fanout-proc' },
      source: { kind: 'builtin', id: 'pipeline-skills', version: '1' },
      toolCallId,
      input: { source: skill.source, sha256: skill.sha256 },
    }
  }
  const outputsByCallIndex: Record<number, LoadSkillOutput> = {}
  const result = await runProviderToolLoop({
    messages: [
      { role: 'system', content: 'Load both skills.' },
      { role: 'user', content: 'Load the analysis and review skills.' },
    ],
    tools: [toolDefinition],
    ...(options.pool === undefined
      ? {}
      : { maxConcurrentToolCalls: options.pool }),
    adapter: {
      complete: async (request) => {
        if (request.messages.some((message) => message.role === 'tool')) {
          return { content: 'loaded', toolCalls: [] }
        }
        return {
          content: null,
          toolCalls: names.map((marker, index) => ({
            id: `${turnLabel}-call-${index + 1}`,
            name: toolDefinition.name,
            arguments: {
              source: skills.get(marker)?.source ?? '',
              sha256: skills.get(marker)?.sha256 ?? '',
            },
          })),
        }
      },
    },
    executeTool: async (call, executionContext) => {
      trace.push(`start:${call.id}`)
      const callIndex = Number(call.id.slice(`${turnLabel}-call-`.length)) - 1
      const marker = names[callIndex]
      assert.ok(marker)
      const output = await gateway.execute({
        ...dispatch(call.id, marker),
        signal: executionContext.signal,
      })
      trace.push(`settle:${call.id}`)
      outputsByCallIndex[callIndex] = output
      return { content: JSON.stringify(output), isError: !output.ok }
    },
  })
  assert.equal(result.text, 'loaded')
  const overlapped =
    trace.indexOf(`start:${turnLabel}-call-2`) !== -1 &&
    trace.indexOf(`settle:${turnLabel}-call-1`) !== -1 &&
    trace.indexOf(`start:${turnLabel}-call-2`) <
      trace.indexOf(`settle:${turnLabel}-call-1`)
  const toolMessageNames = result.messages.flatMap((message) => {
    if (message.role !== 'tool') return []
    const parsed: unknown = JSON.parse(message.content)
    return isRecord(parsed) && typeof parsed.name === 'string'
      ? [parsed.name]
      : []
  })
  return { overlapped, trace, outputsByCallIndex, toolMessageNames }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function makeSkillCatalog(
  repoRootPath: string,
  names: readonly string[],
): Map<string, { readonly source: string; readonly sha256: string; readonly content: string }> {
  const catalog = new Map<
    string,
    { readonly source: string; readonly sha256: string; readonly content: string }
  >()
  for (const name of names) {
    const skillPath = path.join(
      repoRootPath,
      'agents',
      'analyst',
      'skills',
      name,
      'SKILL.md',
    )
    const content = `# ${name} skill\n\nFollow the ${name} checklist.\n`
    fs.mkdirSync(path.dirname(skillPath), { recursive: true })
    fs.writeFileSync(skillPath, content)
    catalog.set(name, {
      source: skillPath,
      sha256: createHash('sha256').update(content).digest('hex'),
      content,
    })
  }
  return catalog
}
