import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserRuntimeError } from '../../domains/browser/browser-manager.js'
import { parseBrowserToolInput } from '../../services/browser-tool-service.js'

test('browser tool input accepts bounded wait intervals and rejects unknown or invalid fields', () => {
  assert.deepEqual(parseBrowserToolInput({
    action: 'wait',
    pageId: 'page-1',
    waitMs: 30_000,
  }), {
    action: 'wait',
    pageId: 'page-1',
    waitMs: 30_000,
  })
  for (const value of [
    { action: 'wait', pageId: 'page-1', waitMs: 99 },
    { action: 'wait', pageId: 'page-1', waitMs: 600_001 },
    { action: 'scroll', pageId: 'page-1', direction: 'sideways' },
    { action: 'read_content', contentId: 'content-1', chunkIndex: -1 },
    { action: 'observe', selector: 'body' },
  ]) {
    assert.throws(
      () => parseBrowserToolInput(value),
      (error: unknown) => error instanceof BrowserRuntimeError && error.code === 'invalid_request',
    )
  }
})
