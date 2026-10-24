import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  claimRecordSchema,
  closedRecordSchema,
  intentRecordSchema,
  ownedProcessScopeFolders,
  publishOrReadScopeRecord,
  publishScopeRecord,
  readScopeRecord,
} from '../../core/owned-processes/owned-process-records.js'

// Requirements (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// section 2): a scope record is published once, only fully written, through the
// scope's staging area and a hard link; exactly one writer wins a name; and a
// record that exists but cannot be opened, parsed or validated is unreadable,
// never absent.

function withScope(fn: (scopePath: string) => Promise<void>): Promise<void> {
  const scopePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-records-')), 'attempt-1')
  for (const folder of Object.values(ownedProcessScopeFolders(scopePath))) {
    fs.mkdirSync(folder, { recursive: true })
  }
  return fn(scopePath).finally(() => {
    fs.chmodSync(ownedProcessScopeFolders(scopePath).staging, 0o700)
    fs.rmSync(path.dirname(scopePath), { recursive: true, force: true })
  })
}

function intent(ownedProcessId: string) {
  return {
    version: 1 as const,
    ownedProcessId,
    parentOwnedProcessId: null,
    kind: 'team' as const,
    childRunId: `child-${ownedProcessId}`,
    spawnerRunId: 'run-1',
    spawnerAssignmentId: 'assignment-1',
    createdAt: new Date().toISOString(),
  }
}

test('a published record reads back whole, and its staging file is gone', async () => {
  await withScope(async (scopePath) => {
    const ownedProcessId = randomUUID()
    const target = path.join(ownedProcessScopeFolders(scopePath).intents, `${ownedProcessId}.json`)
    const record = intent(ownedProcessId)
    const published = await publishScopeRecord({ scopePath, target, record })
    assert.equal(published, 'published')
    const read = await readScopeRecord({ target, schema: intentRecordSchema, expectedOwnedProcessId: ownedProcessId })
    assert.deepEqual(read, { kind: 'present', record })
    assert.deepEqual(fs.readdirSync(ownedProcessScopeFolders(scopePath).staging), [])
  })
})

test('exactly one writer wins a name, and the loser leaves the winner\'s record intact', async () => {
  await withScope(async (scopePath) => {
    const ownedProcessId = randomUUID()
    const target = path.join(ownedProcessScopeFolders(scopePath).claims, `${ownedProcessId}.json`)
    const host = { version: 1 as const, ownedProcessId, claimant: 'host' as const, pid: 4242, processGroupId: 4242, claimedAt: new Date().toISOString() }
    const closer = { version: 1 as const, ownedProcessId, claimant: 'closer' as const, closedBy: 'recovery', claimedAt: new Date().toISOString() }
    const outcomes = await Promise.all([
      publishScopeRecord({ scopePath, target, record: host }),
      publishScopeRecord({ scopePath, target, record: closer }),
    ])
    assert.deepEqual([...outcomes].sort(), ['exists', 'published'])
    const read = await readScopeRecord({ target, schema: claimRecordSchema, expectedOwnedProcessId: ownedProcessId })
    assert.equal(read.kind, 'present')
    const winner = outcomes[0] === 'published' ? host : closer
    assert.deepEqual(read.kind === 'present' ? read.record : undefined, winner)
    assert.deepEqual(fs.readdirSync(ownedProcessScopeFolders(scopePath).staging), [])
  })
})

test('a record is only ever published through staging: when staging cannot be written, nothing appears at its name', async () => {
  await withScope(async (scopePath) => {
    const ownedProcessId = randomUUID()
    const target = path.join(ownedProcessScopeFolders(scopePath).intents, `${ownedProcessId}.json`)
    fs.chmodSync(ownedProcessScopeFolders(scopePath).staging, 0o500)
    await assert.rejects(publishScopeRecord({ scopePath, target, record: intent(ownedProcessId) }))
    assert.equal(fs.existsSync(target), false, 'a record appeared at its final name without passing through staging')
  })
})

test('a record that is absent reads as absent, and every other failure reads as unreadable', async () => {
  await withScope(async (scopePath) => {
    const folders = ownedProcessScopeFolders(scopePath)
    const ownedProcessId = randomUUID()
    const target = path.join(folders.claims, `${ownedProcessId}.json`)
    const read = (expected = ownedProcessId) =>
      readScopeRecord({ target, schema: claimRecordSchema, expectedOwnedProcessId: expected })

    assert.deepEqual(await read(), { kind: 'absent' })

    fs.writeFileSync(target, '')
    assert.equal((await read()).kind, 'unreadable', 'an empty claim, as a create-then-write crash leaves, is unreadable')

    fs.writeFileSync(target, '{"version":1,"ownedProcessId"')
    assert.equal((await read()).kind, 'unreadable', 'a partial claim is unreadable')

    fs.writeFileSync(target, JSON.stringify({ version: 1, ownedProcessId, claimant: 'host', pid: -1, processGroupId: 4, claimedAt: 'x' }))
    assert.equal((await read()).kind, 'unreadable', 'an invalid claim is unreadable')

    fs.writeFileSync(target, JSON.stringify({ version: 1, ownedProcessId: randomUUID(), claimant: 'closer', closedBy: 'recovery', claimedAt: 'x' }))
    assert.equal((await read()).kind, 'unreadable', 'a claim naming another owned process is unreadable')

    fs.rmSync(target)
    const elsewhere = path.join(path.dirname(scopePath), 'elsewhere.json')
    fs.writeFileSync(elsewhere, JSON.stringify({ version: 1, ownedProcessId, claimant: 'closer', closedBy: 'recovery', claimedAt: 'x' }))
    fs.symlinkSync(elsewhere, target)
    assert.equal((await read()).kind, 'unreadable', 'a symbolic link is never followed')

    fs.rmSync(target)
    fs.mkdirSync(target)
    assert.equal((await read()).kind, 'unreadable', 'a directory at a record\'s name is unreadable')
  })
})

test('a name another writer already holds counts only once its record reads back valid', async () => {
  await withScope(async (scopePath) => {
    const target = path.join(scopePath, 'closed.json')
    const record = { version: 1 as const, closedBy: 'recovery', closedAt: new Date().toISOString() }
    const publish = () => publishOrReadScopeRecord({ scopePath, target, record, schema: closedRecordSchema })

    fs.writeFileSync(target, '')
    assert.equal((await publish()).kind, 'unreadable', 'an empty winner is not a closure')
    fs.writeFileSync(target, '{"version":1,"closedBy"')
    assert.equal((await publish()).kind, 'unreadable', 'a malformed winner is not a closure')

    fs.rmSync(target)
    assert.deepEqual(await publish(), { kind: 'published', record })
    const earlier = await readScopeRecord({ target, schema: closedRecordSchema })
    assert.deepEqual(await publish(), { kind: 'existing', record: earlier.kind === 'present' ? earlier.record : undefined })
  })
})

test('a winner naming another owned process is unreadable, and an invalid record is never written', async () => {
  await withScope(async (scopePath) => {
    const ownedProcessId = randomUUID()
    const target = path.join(ownedProcessScopeFolders(scopePath).claims, `${ownedProcessId}.json`)
    fs.writeFileSync(target, JSON.stringify({
      version: 1, ownedProcessId: randomUUID(), claimant: 'closer', closedBy: 'recovery', claimedAt: 'x',
    }))
    const closer = { version: 1 as const, ownedProcessId, claimant: 'closer' as const, closedBy: 'recovery', claimedAt: 'x' }
    assert.equal((await publishOrReadScopeRecord({
      scopePath, target, record: closer, schema: claimRecordSchema, expectedOwnedProcessId: ownedProcessId,
    })).kind, 'unreadable')

    const fresh = path.join(ownedProcessScopeFolders(scopePath).claims, `${randomUUID()}.json`)
    await assert.rejects(publishOrReadScopeRecord({
      scopePath, target: fresh, record: { version: 1, claimant: 'host' }, schema: claimRecordSchema,
    }))
    assert.equal(fs.existsSync(fresh), false, 'an invalid record was published')
  })
})
