import assert from 'node:assert/strict'
import test from 'node:test'

import { CHAT_VISUALIZATION_POLICY } from '../../core/chat-visualization-policy.js'

test('chat lets the model choose supported visual formats without preferring Mermaid', () => {
  assert.match(CHAT_VISUALIZATION_POLICY, /Choose the chart or diagram format that best explains the answer/)
  assert.match(CHAT_VISUALIZATION_POLICY, /Mermaid is one option, not a requirement or default/)
  assert.match(CHAT_VISUALIZATION_POLICY, /available tools and rendering capabilities/)
  assert.doesNotMatch(CHAT_VISUALIZATION_POLICY, /Prefer Mermaid|If Mermaid would be fragile/)
})
