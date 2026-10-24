import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type, type TSchema } from 'typebox'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type { CapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityDispatchEvent,
  CapabilityExecutionContext,
} from '../../contracts/capability-dispatch.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import {
  createDefaultTeamRuntimeToolAdapterFactory,
  governTeamRuntimeTool,
  type TeamRuntimeToolAdapterFactory,
  type TeamRuntimeToolArguments,
} from '../../team-runtime/capability-tool-adapter.js'
import {
  createPipelinePiToolAdapterFactory,
  createPipelinePiToolDefinitions,
  PIPELINE_GOVERNED_PI_TOOL_NAMES,
  type PipelineGovernedPiToolName,
} from '../../team-runtime/governed-pi-tools.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const CONTEXT: CapabilityExecutionContext = {
  contractVersion: 1,
  requestId: 'request-pi-tools-1',
  sessionId: 'session-pi-tools-1',
  runId: 'run-pi-tools-1',
  assignmentId: 'assignment-pi-tools-1',
  taskId: 'task-pi-tools-1',
  agentPath: 'agents/coordinator',
  authority: {
    kind: 'runtime-assignment',
    processIdentity: 'process-pi-tools-1',
  },
}

test('all seven Pipeline-owned Pi replacements execute real local work through dispatch', async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-governed-pi-'))
  context.after(() => fs.rm(cwd, { recursive: true, force: true }))
  await fs.writeFile(path.join(cwd, 'seed.txt'), 'needle alpha\n', 'utf8')
  const events: CapabilityDispatchEvent[] = []
  const dispatcher = createCapabilityTestDispatcher(events)
  const tools = createPipelinePiToolDefinitions(cwd)

  await executeGoverned(tools.write, 'write', cwd, 'call-write', {
    path: 'result.txt',
    content: 'before value\n',
  }, dispatcher)
  await executeGoverned(tools.edit, 'edit', cwd, 'call-edit', {
    path: 'result.txt',
    edits: [{ oldText: 'before', newText: 'governed' }],
  }, dispatcher)
  const read = await executeGoverned(tools.read, 'read', cwd, 'call-read', {
    path: 'result.txt',
  }, dispatcher)
  const bash = await executeGoverned(tools.bash, 'bash', cwd, 'call-bash', {
    command: "printf 'process-ok'",
  }, dispatcher)
  const grep = await executeGoverned(tools.grep, 'grep', cwd, 'call-grep', {
    pattern: 'governed',
    path: '.',
  }, dispatcher)
  const find = await executeGoverned(tools.find, 'find', cwd, 'call-find', {
    pattern: '*.txt',
    path: '.',
  }, dispatcher)
  const ls = await executeGoverned(tools.ls, 'ls', cwd, 'call-ls', {
    path: '.',
  }, dispatcher)

  assert.match(textContent(read), /governed/u)
  assert.match(textContent(bash), /process-ok/u)
  assert.match(textContent(grep), /result\.txt/u)
  assert.match(textContent(find), /result\.txt/u)
  assert.match(textContent(ls), /result\.txt/u)
  assert.equal(await fs.readFile(path.join(cwd, 'result.txt'), 'utf8'), 'governed value\n')
  const requestedCapabilities = events
    .filter((event) => event.type === 'capability.dispatch.requested')
    .map((event) => event.capabilityId)
    .sort()
  assert.deepEqual(
    requestedCapabilities,
    PIPELINE_GOVERNED_PI_TOOL_NAMES
      .map((name) => `team-runtime.pi.${name}`)
      .sort(),
  )
})

test('governed Pi bash denies a mutated destructive command before local execution', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-bash-policy-'))
  context.after(() => fs.rm(parent, { recursive: true, force: true }))
  const cwd = path.join(parent, 'workspace')
  const protectedPath = path.join(parent, 'protected-marker')
  await fs.mkdir(cwd)
  await fs.mkdir(protectedPath)
  const tool = createPipelinePiToolDefinitions(cwd).bash
  const governed = governTeamRuntimeTool({
    tool,
    dispatcher: createCapabilityTestDispatcher(),
    getContext: () => CONTEXT,
    modelSource: { kind: 'pi-host', id: 'team-runtime:pi-model', version: '1' },
    runtimeSource: { kind: 'engine', id: 'team-runtime:runtime-autostart', version: '1' },
    adapterFactory: createPiToolAdapter(tool, {
      name: 'bash',
      cwd,
      effect: serialCapabilityEffect('unknown'),
    }),
  })

  await assert.rejects(
    governed.invoke({
      channel: 'model',
      toolCallId: 'mutated-bash-call',
      input: { command: "rm -rf '../protected-marker'" },
      extensionContext: emptyExtensionContext(),
    }),
    (error: unknown) => hasCode(error, 'unsafe_bash_command'),
  )
  assert.equal((await fs.stat(protectedPath)).isDirectory(), true)
})

test('governed Pi file tools deny a path that escapes the assignment workspace', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-path-policy-'))
  context.after(() => fs.rm(parent, { recursive: true, force: true }))
  const cwd = path.join(parent, 'workspace')
  const escapedPath = path.join(parent, 'escaped.txt')
  await fs.mkdir(cwd)
  const tool = createPipelinePiToolDefinitions(cwd).write
  const governed = governTeamRuntimeTool({
    tool,
    dispatcher: createCapabilityTestDispatcher(),
    getContext: () => CONTEXT,
    modelSource: { kind: 'pi-host', id: 'team-runtime:pi-model', version: '1' },
    runtimeSource: { kind: 'engine', id: 'team-runtime:runtime-autostart', version: '1' },
    adapterFactory: createPiToolAdapter(tool, {
      name: 'write',
      cwd,
      effect: serialCapabilityEffect('mutating'),
    }),
  })

  await assert.rejects(
    governed.invoke({
      channel: 'model',
      toolCallId: 'escaping-write-call',
      input: { path: '../escaped.txt', content: 'must not be written' },
      extensionContext: emptyExtensionContext(),
    }),
    (error: unknown) => hasCode(error, 'tool_path_outside_workspace'),
  )
  await assert.rejects(fs.stat(escapedPath), { code: 'ENOENT' })
})

test('queued governed Pi writes recheck a path after an in-workspace directory becomes an escaping symlink', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-path-race-'))
  context.after(() => fs.rm(parent, { recursive: true, force: true }))
  const cwd = path.join(parent, 'workspace')
  const safeDirectory = path.join(cwd, 'safe')
  const outsideDirectory = path.join(parent, 'outside')
  await fs.mkdir(safeDirectory, { recursive: true })
  await fs.mkdir(outsideDirectory)

  let releaseBlocker: (() => void) | undefined
  const blockerRelease = new Promise<void>((resolve) => {
    releaseBlocker = resolve
  })
  let markBlockerStarted: (() => void) | undefined
  const blockerStarted = new Promise<void>((resolve) => {
    markBlockerStarted = resolve
  })
  let markWriteQueued: (() => void) | undefined
  const writeQueued = new Promise<void>((resolve) => {
    markWriteQueued = resolve
  })
  const serialScheduler = new PerAuthorityCapabilityExecutionScheduler()
  let schedulerCalls = 0
  const dispatcher = createCapabilityTestDispatcher([], {
    scheduler: {
      run: async (input) => {
        schedulerCalls += 1
        if (schedulerCalls === 2) {
          markWriteQueued?.()
        }
        return serialScheduler.run(input)
      },
    },
  })
  const blockerTool = defineTool({
    name: 'scheduler_blocker',
    label: 'Scheduler blocker',
    description: 'Holds the serial capability lane.',
    parameters: Type.Object({}),
    execute: async () => {
      markBlockerStarted?.()
      await blockerRelease
      return {
        content: [{ type: 'text' as const, text: 'released' }],
        details: { blocked: true },
      }
    },
  })
  const blocker = governTeamRuntimeTool({
    tool: blockerTool,
    dispatcher,
    getContext: () => CONTEXT,
    modelSource: { kind: 'pi-host', id: 'team-runtime:pi-model', version: '1' },
    runtimeSource: { kind: 'engine', id: 'team-runtime:runtime-autostart', version: '1' },
    adapterFactory: createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: 'team-runtime.test.scheduler-blocker',
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-blocker',
    }),
  })
  const writeTool = createPipelinePiToolDefinitions(cwd).write
  const governedWrite = governTeamRuntimeTool({
    tool: writeTool,
    dispatcher,
    getContext: () => CONTEXT,
    modelSource: { kind: 'pi-host', id: 'team-runtime:pi-model', version: '1' },
    runtimeSource: { kind: 'engine', id: 'team-runtime:runtime-autostart', version: '1' },
    adapterFactory: createPiToolAdapter(writeTool, {
      name: 'write',
      cwd,
      effect: serialCapabilityEffect('mutating'),
    }),
  })

  const blockerRun = blocker.invoke({
    channel: 'model',
    toolCallId: 'scheduler-blocker-call',
    input: {},
    extensionContext: emptyExtensionContext(),
  })
  await blockerStarted
  const writeRun = governedWrite.invoke({
    channel: 'model',
    toolCallId: 'queued-write-call',
    input: { path: 'safe/output.txt', content: 'must stay inside' },
    extensionContext: emptyExtensionContext(),
  })
  const writeRejection = assert.rejects(
    writeRun,
    (error: unknown) => hasCode(error, 'tool_path_outside_workspace'),
  )
  await writeQueued
  await fs.rmdir(safeDirectory)
  await fs.symlink(outsideDirectory, safeDirectory, 'dir')
  releaseBlocker?.()

  await writeRejection
  await blockerRun
  await assert.rejects(fs.stat(path.join(outsideDirectory, 'output.txt')), {
    code: 'ENOENT',
  })
})

async function executeGoverned<
  TParams extends TSchema,
  TDetails,
  TState,
>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  name: PipelineGovernedPiToolName,
  cwd: string,
  toolCallId: string,
  input: TeamRuntimeToolArguments<TParams>,
  dispatcher: ReturnType<typeof createCapabilityTestDispatcher>,
): Promise<AgentToolResult<TDetails>> {
  const governed = governTeamRuntimeTool({
    tool,
    dispatcher,
    getContext: () => CONTEXT,
    modelSource: {
      kind: 'pi-host',
      id: 'team-runtime:pi-model',
      version: '1',
    },
    runtimeSource: {
      kind: 'engine',
      id: 'team-runtime:runtime-autostart',
      version: '1',
    },
    adapterFactory: createPiToolAdapter(tool, {
      name,
      cwd,
      effect: serialCapabilityEffect(
        name === 'read' || name === 'grep' || name === 'find' || name === 'ls'
          ? 'read-only'
          : name === 'bash'
            ? 'unknown'
            : 'mutating',
      ),
    }),
  })
  return governed.invoke({
    channel: 'model',
    toolCallId,
    input,
    extensionContext: emptyExtensionContext(),
  })
}

function createPiToolAdapter<
  TParams extends TSchema,
  TDetails,
  TState,
>(
  _tool: ToolDefinition<TParams, TDetails, TState>,
  input: {
    readonly name: PipelineGovernedPiToolName
    readonly cwd: string
    readonly effect: CapabilityEffect
  },
): TeamRuntimeToolAdapterFactory<TParams, TDetails> {
  return createPipelinePiToolAdapterFactory<TParams, TDetails>(input)
}

function emptyExtensionContext(): ExtensionContext {
  return Object.assign(Object.create(null), {
    sessionManager: {
      getSessionId: () => 'pi-tool-test-session',
      getSessionFile: () => undefined,
    },
    model: undefined,
    thinkingLevel: undefined,
  })
}

function textContent(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
