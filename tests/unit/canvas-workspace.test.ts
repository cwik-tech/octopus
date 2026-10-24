import test from 'node:test'
import assert from 'node:assert/strict'
import { canvasActionSchema, canvasWorkspaceSchema, CANVAS_MAX_TABS, canvasTabKey } from '../../contracts/canvas-workspace.js'
import { applyCanvasAction as applyActionResult, emptyCanvasWorkspace } from '../../core/canvas-workspace.js'
import type { CanvasAction, CanvasWorkspace } from '../../contracts/canvas-workspace.js'

function applyCanvasAction(state: CanvasWorkspace, action: CanvasAction): CanvasWorkspace {
  const result = applyActionResult(state, action)
  assert.ok(result.ok)
  return result.workspace
}

const alpha = { runId: 'run-alpha', artifactPath: 'files/report.md' }
const beta = { runId: 'run-beta', artifactPath: 'files/report.md' }

test('opening the same artifact selects one tab while identical names in other runs remain distinct', () => {
  const first = applyCanvasAction(emptyCanvasWorkspace(), { kind: 'open', target: alpha })
  const second = applyCanvasAction(first, { kind: 'open', target: beta })
  const reopened = applyCanvasAction(second, { kind: 'open', target: alpha })
  assert.deepEqual(reopened.tabs, [alpha, beta])
  assert.equal(reopened.activeKey, '["run-alpha","files/report.md"]')
  assert.equal(reopened.revision, 3)
})

test('closing active, inactive and last tabs preserves a valid adjacent selection', () => {
  const first = applyCanvasAction(emptyCanvasWorkspace(), { kind: 'open', target: alpha })
  const both = applyCanvasAction(first, { kind: 'open', target: beta })
  assert.equal(applyCanvasAction(both, { kind: 'close', key: canvasTabKey(alpha) }).activeKey, canvasTabKey(beta))
  const remaining = applyCanvasAction(both, { kind: 'close', key: canvasTabKey(beta) })
  assert.equal(remaining.activeKey, canvasTabKey(alpha))
  assert.deepEqual(applyCanvasAction(remaining, { kind: 'close', key: canvasTabKey(alpha) }).tabs, [])
  assert.equal(applyCanvasAction(remaining, { kind: 'close', key: canvasTabKey(alpha) }).activeKey, null)
  assert.deepEqual(applyCanvasAction(first, { kind: 'close', key: 'unknown' }), first)
})

test('the tab limit refuses another document without removing existing tabs', () => {
  const tabs = Array.from({ length: CANVAS_MAX_TABS }, (_, index) => ({ runId: `run-${index}`, artifactPath: 'report.md' }))
  const full = { schemaVersion: 1 as const, revision: 1, tabs, activeKey: '["run-0","report.md"]' }
  assert.deepEqual(applyActionResult(full, { kind: 'open', target: alpha }), { ok: false, reason: 'tab_limit' })
  assert.equal(full.tabs.length, CANVAS_MAX_TABS)
})

test('external actions reject traversal, absolute paths, separators, oversized IDs and extra keys', () => {
  for (const artifactPath of ['../secret.md', '/secret.md', 'files//x.md', 'files/./x.md', 'files\\x.md', 'files/x\u0000.md']) {
    assert.equal(canvasActionSchema.safeParse({ kind: 'open', target: { ...alpha, artifactPath } }).success, false, artifactPath)
  }
  assert.equal(canvasActionSchema.safeParse({ kind: 'open', target: { ...alpha, runId: 'x'.repeat(201) } }).success, false)
  assert.equal(canvasActionSchema.safeParse({ kind: 'close', key: 'x', extra: true }).success, false)
})

test('saved workspaces refuse duplicate tabs, dangling selections and unknown schemas', () => {
  assert.equal(canvasWorkspaceSchema.safeParse({ schemaVersion: 1, revision: 1, tabs: [alpha, alpha], activeKey: canvasTabKey(alpha) }).success, false)
  assert.equal(canvasWorkspaceSchema.safeParse({ schemaVersion: 1, revision: 1, tabs: [alpha], activeKey: 'missing' }).success, false)
  assert.equal(canvasWorkspaceSchema.safeParse({ schemaVersion: 2, revision: 1, tabs: [], activeKey: null }).success, false)
})

test('a valid escaped filename still produces a workspace that can be saved and reopened', () => {
  const target = { runId: 'run-alpha', artifactPath: `files/${'"'.repeat(900)}.md` }
  const state = applyCanvasAction(emptyCanvasWorkspace(), { kind: 'open', target })
  assert.equal(canvasWorkspaceSchema.safeParse(state).success, true)
})
