/**
 * The conversation registry is owned by the composition that built it.
 *
 * A registry is the single authority for its activities: it decides who holds
 * what and refuses to open a second handle for one. That guarantee ends at
 * process teardown only if teardown actually closes it — and the close lived in
 * a branch the normal workspace never takes, so on the usual path the registry
 * stayed open and would still hand out leases after the composition it belongs
 * to had been disposed.
 *
 * Ownership order, not a duplicated close: the registry is acquired before the
 * things that use it, and disposal runs in reverse, so it is released after the
 * requests that were still draining.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { buildServices } from '../../server/composition.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'

test('disposing the composition closes the conversation registry', async (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'composition-conversation-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions'), { recursive: true })
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const composition = await buildServices({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: path.join(directory, 'project'),
    workspacePath,
  })
  const registry = composition.services.conversationJournalRegistry
  assert.ok(registry, 'the normal workspace path builds one')

  // Working before, barred after. Nothing may open an activity through a
  // registry whose owner has gone.
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  const owner = {
    kind: 'run-session' as const,
    conversationId: sessionId,
    sessionId,
  }
  const before = await registry.acquire({
    owner,
    activityId: randomUUID(),
    activityKind: 'turn',
  })
  assert.ok(before, 'the registry is usable while its composition is alive')
  await before.release()

  await composition.dispose()

  await assert.rejects(
    registry.acquire({ owner, activityId: randomUUID(), activityKind: 'turn' }),
    'a disposed composition leaves nothing able to open a new activity',
  )
})
