import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { BrowserContentStore } from '../../domains/browser/browser-content-store.js'

test('browser content store chunks UTF-8 text, supports search, and isolates assignments', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-content-')))
  const store = new BrowserContentStore()
  const text = `${'α'.repeat(20_000)}\nunique orbital evidence\n${'β'.repeat(20_000)}`
  try {
    const content = await store.write({
      assignmentKey: 'assignment-a',
      assignmentPath: root,
      text,
    })
    assert.ok(content.chunkCount > 1)
    assert.equal(content.sizeBytes, Buffer.byteLength(text, 'utf8'))
    const matches = store.search('assignment-a', content.id, 'orbital evidence')
    assert.equal(matches?.length, 1)
    const chunk = store.read('assignment-a', content.id, matches?.[0]?.chunkIndex)
    assert.match(chunk?.text ?? '', /unique orbital evidence/)
    assert.equal(store.read('assignment-b', content.id, 0), null)
    assert.equal(store.search('assignment-b', content.id, 'orbital'), null)
    assert.equal(fs.existsSync(path.join(root, 'browser-content', `${content.id}.txt`)), true)
    store.releaseAssignment('assignment-a')
    assert.equal(store.read('assignment-a', content.id, 0), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
