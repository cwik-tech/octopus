import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDelegatedRecoveryPrompt } from '../../domains/agent-execution/agent-runner.js'

test('buildDelegatedRecoveryPrompt preserves the original prompt', () => {
  const result = buildDelegatedRecoveryPrompt('incoming-brief.md', 'report.md', 'Do the work.')
  assert.match(result, /Do the work\./)
})

test('buildDelegatedRecoveryPrompt includes the missing output artifact name', () => {
  const result = buildDelegatedRecoveryPrompt('incoming-brief.md', 'report.md', 'Do the work.')
  assert.match(result, /`report\.md`/)
})

test('buildDelegatedRecoveryPrompt includes the input artifact as source of truth', () => {
  const result = buildDelegatedRecoveryPrompt('incoming-brief.md', 'report.md', 'Do the work.')
  assert.match(result, /`incoming-brief\.md`/)
})

test('buildDelegatedRecoveryPrompt includes chain stage guidance to call handoff immediately', () => {
  const result = buildDelegatedRecoveryPrompt('incoming-brief.md', 'draft-package.md', 'Write.')
  assert.match(result, /If the stage is chain, call `handoff` immediately/i)
})

test('buildDelegatedRecoveryPrompt instructs chain recovery to treat gaps as non-blocking', () => {
  const result = buildDelegatedRecoveryPrompt('incoming-brief.md', 'draft-package.md', 'Write.')
  assert.match(result, /treat all unresolved gaps as non-blocking/i)
  assert.match(result, /proceed with available analysis as the source of truth/i)
})

test('buildDelegatedRecoveryPrompt includes discussion stage guidance', () => {
  const result = buildDelegatedRecoveryPrompt('incoming-brief.md', 'report.md', 'Discuss.')
  assert.match(result, /If the stage is discussion/)
  assert.match(result, /call `set_roster`/)
  assert.match(result, /call `converse`/)
})

test('buildDelegatedRecoveryPrompt keeps routing recovery non-interactive', () => {
  const result = buildDelegatedRecoveryPrompt('incoming-brief.md', 'routing-decision.md', 'Route this request.')
  assert.match(result, /If the stage is routing, do not ask follow-up questions or wait for approval/i)
  assert.match(result, /call `spawn_team` now/i)
})

test('buildDelegatedRecoveryPrompt instructs surfacing blockers instead of silent exit', () => {
  const result = buildDelegatedRecoveryPrompt('incoming-brief.md', 'report.md', 'Do the work.')
  assert.match(result, /surface the blocker explicitly/)
})
