import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { DEFAULT_MAX_SPAWN_DEPTH } from '../../core/constants.js'
import { walkAncestors } from '../../core/owned-processes/owned-process-lineage.js'
import { ownedProcessScopeFolders } from '../../core/owned-processes/owned-process-records.js'

// Requirement (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// section 5, "Walking an ancestor chain"): follow parentOwnedProcessId through
// the intents to a null parent. The walk fails, and never loops, when a
// parent's intent is absent, unreadable or invalid, when an id repeats, or when
// it passes DEFAULT_MAX_SPAWN_DEPTH + 1 intents.

async function withScope(fn: (scopePath: string, write: (id: string, parent: string | null | 'invalid') => void) => Promise<void>): Promise<void> {
  const scopePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-lineage-')), 'attempt-1')
  for (const folder of Object.values(ownedProcessScopeFolders(scopePath))) fs.mkdirSync(folder, { recursive: true })
  const write = (id: string, parent: string | null | 'invalid'): void => {
    fs.writeFileSync(
      path.join(ownedProcessScopeFolders(scopePath).intents, `${id}.json`),
      parent === 'invalid'
        ? JSON.stringify({ version: 1, ownedProcessId: id })
        : JSON.stringify({
            version: 1,
            ownedProcessId: id,
            parentOwnedProcessId: parent,
            kind: 'team',
            childRunId: `child-${id}`,
            spawnerRunId: 'run',
            spawnerAssignmentId: 'assignment',
            createdAt: 'now',
          }),
    )
  }
  try {
    await fn(scopePath, write)
  } finally {
    fs.rmSync(path.dirname(scopePath), { recursive: true, force: true })
  }
}

test('a chain to the root walks, nearest ancestor first', async () => {
  await withScope(async (scopePath, write) => {
    write('root-child', null)
    write('nested', 'root-child')
    write('deepest', 'nested')
    assert.deepEqual(await walkAncestors(scopePath, 'deepest'), {
      kind: 'walked',
      ancestors: ['nested', 'root-child'],
    })
    assert.deepEqual(await walkAncestors(scopePath, 'root-child'), { kind: 'walked', ancestors: [] })
  })
})

test('the longest real chain walks, and one intent more fails', async () => {
  await withScope(async (scopePath, write) => {
    const longest = DEFAULT_MAX_SPAWN_DEPTH + 1
    for (let index = 0; index <= longest; index += 1) write(`level-${index}`, index === 0 ? null : `level-${index - 1}`)
    assert.equal((await walkAncestors(scopePath, `level-${longest - 1}`)).kind, 'walked')
    assert.equal((await walkAncestors(scopePath, `level-${longest}`)).kind, 'failed')
  })
})

test('a missing, invalid or repeating chain fails instead of hanging', async () => {
  await withScope(async (scopePath, write) => {
    write('orphan', 'never-recorded')
    assert.equal((await walkAncestors(scopePath, 'orphan')).kind, 'failed', 'a missing parent')
    write('broken-parent', 'invalid')
    write('child-of-broken', 'broken-parent')
    assert.equal((await walkAncestors(scopePath, 'child-of-broken')).kind, 'failed', 'an invalid parent')
    write('cycle-a', 'cycle-b')
    write('cycle-b', 'cycle-a')
    assert.equal((await walkAncestors(scopePath, 'cycle-a')).kind, 'failed', 'a cycle')
    write('self', 'self')
    assert.equal((await walkAncestors(scopePath, 'self')).kind, 'failed', 'a self-parent')
    assert.equal((await walkAncestors(scopePath, 'no-intent-at-all')).kind, 'failed', 'its own intent missing')
  })
})
