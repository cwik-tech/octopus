import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildServices } from '../../server/composition.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'

/**
 * The web evidence rollout boundary (plan §6.2, §8.1): strict settings fail
 * startup rather than silently resolving to a different posture, and the
 * telemetry-requiring modes fail startup when there is no journal registry to
 * record through.
 */

async function makeWorkspace(t: {
  after: (fn: () => unknown) => void
}): Promise<string> {
  const workspacePath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'web-evidence-rollout-')),
  )
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  return workspacePath
}

function withEnvironment(
  t: { after: (fn: () => unknown) => void },
  values: Readonly<Record<string, string | undefined>>,
): void {
  const previous = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

async function compositionOptions(workspacePath: string) {
  const repoRootPath = process.cwd()
  const launcher = {
    async startRun() {
      return { launched: true as const, pid: process.pid, cwd: repoRootPath }
    },
  }
  return {
    store: new FileSystemRunStore(workspacePath),
    launcher,
    taskLauncher: launcher,
    fileParserLauncher: new SourceFileParserLauncher(repoRootPath),
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    repoRootPath,
    workflowsRegistryPath: path.join(repoRootPath, 'workflows', 'registry.yaml'),
  }
}

test('an unrecognised web evidence mode fails startup, naming the variable and the value', async (t) => {
  const workspacePath = await makeWorkspace(t)
  withEnvironment(t, { PIPELINE_WEB_EVIDENCE_LINKS: 'enfore' })

  await assert.rejects(
    buildServices(await compositionOptions(workspacePath)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /PIPELINE_WEB_EVIDENCE_LINKS/)
      assert.match(error.message, /enfore/)
      return true
    },
    'a typo must fail startup rather than silently turning enforcement off',
  )
})

test('malformed claim cohorts fail startup, naming the variable', async (t) => {
  const workspacePath = await makeWorkspace(t)
  withEnvironment(t, {
    PIPELINE_WEB_EVIDENCE_CLAIM_COHORTS: 'openai:mcp-native',
  })

  await assert.rejects(
    buildServices(await compositionOptions(workspacePath)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /PIPELINE_WEB_EVIDENCE_CLAIM_COHORTS/)
      return true
    },
  )
})

test('shadow mode without a workspace journal registry fails startup', async (t) => {
  withEnvironment(t, { PIPELINE_WEB_EVIDENCE_LINKS: 'shadow' })
  const repoRootPath = process.cwd()
  const launcher = {
    async startRun() {
      return { launched: true as const, pid: process.pid, cwd: repoRootPath }
    },
  }

  await assert.rejects(
    buildServices({
      store: new FileSystemRunStore(
        await fs.mkdtemp(path.join(os.tmpdir(), 'web-evidence-no-workspace-')),
      ),
      launcher,
      taskLauncher: launcher,
      fileParserLauncher: new SourceFileParserLauncher(repoRootPath),
      repoRootPath,
      workflowsRegistryPath: path.join(repoRootPath, 'workflows', 'registry.yaml'),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /PIPELINE_WEB_EVIDENCE_LINKS/)
      assert.match(error.message, /execution journal/)
      return true
    },
    'shadow without a recorder would read as a cohort with zero rejections',
  )
})

test('shadow mode with a workspace starts and defaults stay off', async (t) => {
  const workspacePath = await makeWorkspace(t)
  withEnvironment(t, { PIPELINE_WEB_EVIDENCE_LINKS: 'shadow' })
  const shadowComposition = await buildServices(
    await compositionOptions(workspacePath),
  )
  t.after(() => shadowComposition.dispose())
  assert.ok(shadowComposition.services.mcpAgentToolService)
  assert.ok(
    shadowComposition.services.executionJournalRegistry,
    'the recorder resolves through the registry the composition already owns',
  )
})

test('an unset rollout configuration preserves the default-off startup', async (t) => {
  const workspacePath = await makeWorkspace(t)
  withEnvironment(t, {
    PIPELINE_WEB_EVIDENCE_LINKS: undefined,
    PIPELINE_WEB_EVIDENCE_LINKS_PERCENT: undefined,
    PIPELINE_WEB_EVIDENCE_CLAIMS: undefined,
    PIPELINE_WEB_EVIDENCE_CLAIMS_PERCENT: undefined,
    PIPELINE_WEB_EVIDENCE_CLAIM_COHORTS: undefined,
  })
  const composition = await buildServices(await compositionOptions(workspacePath))
  t.after(() => composition.dispose())
  assert.ok(composition.services.mcpAgentToolService)
})

test('shadow mode with durable journals disabled fails startup', async (t) => {
  const workspacePath = await makeWorkspace(t)
  withEnvironment(t, {
    PIPELINE_DURABLE_JOURNAL: 'disabled',
    PIPELINE_WEB_EVIDENCE_LINKS: 'shadow',
  })

  await assert.rejects(
    buildServices(await compositionOptions(workspacePath)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /PIPELINE_WEB_EVIDENCE_LINKS/)
      assert.match(error.message, /execution journal/)
      return true
    },
    'a registry that cannot enroll new assignments is no recorder at all',
  )
})

test('enforce mode with durable journals disabled fails startup', async (t) => {
  const workspacePath = await makeWorkspace(t)
  withEnvironment(t, {
    PIPELINE_DURABLE_JOURNAL: 'disabled',
    PIPELINE_WEB_EVIDENCE_LINKS: 'enforce',
  })

  await assert.rejects(
    buildServices(await compositionOptions(workspacePath)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /PIPELINE_WEB_EVIDENCE_LINKS/)
      return true
    },
  )
})
