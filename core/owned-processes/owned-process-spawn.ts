/**
 * The spawner's side of an owned process
 * (`docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md`,
 * sections 2 to 4): the command that starts a target through its host.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  OWNED_PROCESS_ARGUMENT,
  OWNED_PROCESS_ID_ENV,
  OWNED_PROCESS_SCOPE_ENV,
  intentRecordSchema,
  ownedProcessScopeFolders,
  publishOrReadScopeRecord,
  type IntentRecord,
} from './owned-process-records.js'

export interface PreparedOwnedProcess {
  readonly ownedProcessId: string
  readonly scopePath: string
}

/**
 * Records the intent for a detached spawn this process is about to make, when
 * it holds an ownership scope. Its parent is this process's own owned process
 * id (a root worker has none). Returns undefined, and changes nothing, when
 * the process holds no scope or on Windows.
 */
export async function prepareOwnedProcess(input: {
  readonly environment: NodeJS.ProcessEnv
  readonly kind: IntentRecord['kind']
  readonly childRunId: string | null
  readonly spawnerRunId: string | null
  readonly spawnerAssignmentId: string | null
}): Promise<PreparedOwnedProcess | undefined> {
  if (process.platform === 'win32') return undefined
  const scopePath = input.environment[OWNED_PROCESS_SCOPE_ENV]?.trim()
  if (!scopePath) return undefined
  const ownedProcessId = randomUUID()
  const published = await publishOrReadScopeRecord({
    scopePath,
    target: path.join(ownedProcessScopeFolders(scopePath).intents, `${ownedProcessId}.json`),
    record: {
      version: 1,
      ownedProcessId,
      parentOwnedProcessId: input.environment[OWNED_PROCESS_ID_ENV]?.trim() || null,
      kind: input.kind,
      childRunId: input.childRunId,
      spawnerRunId: input.spawnerRunId,
      spawnerAssignmentId: input.spawnerAssignmentId,
      createdAt: new Date().toISOString(),
    },
    schema: intentRecordSchema,
    expectedOwnedProcessId: ownedProcessId,
  })
  if (published.kind !== 'published') {
    throw new Error(`The intent for owned process ${ownedProcessId} could not be published in ${scopePath}`)
  }
  return { ownedProcessId, scopePath }
}

/**
 * The environment a host needs beside its target's own: the scope, and, when
 * this process is Electron running as Node, the flag that lets the same
 * binary run the host as Node.
 */
export function ownedProcessHostEnvironment(prepared: PreparedOwnedProcess): NodeJS.ProcessEnv {
  return {
    [OWNED_PROCESS_SCOPE_ENV]: prepared.scopePath,
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }
}

export interface OwnedProcessTarget {
  readonly ownedProcessId: string
  readonly command: string
  readonly args: readonly string[]
}

export interface OwnedProcessHostInvocation {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * How to start `target` through the owned process host.
 *
 * A build runs the host's compiled module directly. Running from source (the
 * task runner is started through tsx there), the host's TypeScript module is
 * loaded through tsx's loader in the same process: tsx's CLI would start a
 * second process carrying the same marker, and the host must be the one
 * process that leads its group and carries it.
 */
export function ownedProcessHostInvocation(target: OwnedProcessTarget): OwnedProcessHostInvocation {
  const fromSource = import.meta.url.endsWith('.ts')
  const hostPath = fileURLToPath(new URL(fromSource ? './owned-process-host.ts' : './owned-process-host.js', import.meta.url))
  const loader = fromSource
    ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href]
    : []
  return {
    command: process.execPath,
    args: [
      ...loader,
      hostPath,
      `${OWNED_PROCESS_ARGUMENT}${target.ownedProcessId}`,
      '--',
      target.command,
      ...target.args,
    ],
  }
}
