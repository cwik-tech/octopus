import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTaskOutcomeChatMessage,
  sanitizeTaskOutcomeReason,
} from '../../domains/sessions/task-recovery-manager.js'

test('a stopped run names its workflow and step and carries a sanitized reason', () => {
  const leakedPath = '/Users/tester/Library/Application Support/pipeline/manual.docx'
  const summary = [
    "Step 'build_manual' failed.",
    '   Bundled YouTube media tools are unavailable.',
    `   Expected ${leakedPath}.`,
  ].join('\n')

  const failed = buildTaskOutcomeChatMessage({
    status: 'failed',
    workflowId: 'youtube-manual-generation',
    stepId: 'build_manual',
    summary,
  })

  assert.match(failed.text, /youtube-manual-generation/)
  assert.match(failed.text, /build_manual/)
  assert.match(failed.text, /Bundled YouTube media tools are unavailable\./)
  // The summary is a single line once it reaches the transcript, and the
  // absolute path it named is reduced to the file name.
  assert.equal(failed.text.includes('\n'), false)
  assert.equal(failed.text.includes(leakedPath), false)
  assert.equal(failed.text.includes('/Users'), false)
  assert.match(failed.text, /manual\.docx/)
  assert.equal(
    failed.reason,
    "Step 'build_manual' failed. Bundled YouTube media tools are unavailable. Expected manual.docx.",
  )

  const blocked = buildTaskOutcomeChatMessage({
    status: 'blocked',
    workflowId: 'youtube-manual-generation',
    stepId: 'extract',
    summary: "Provider 'codex' failed: You've hit your provider usage limit",
  })

  assert.match(blocked.text, /blocked/)
  assert.match(blocked.text, /extract/)
  assert.match(blocked.text, /provider usage limit/)
})

test('an over-long or absent workflow summary still leaves one readable chat line', () => {
  const capped = buildTaskOutcomeChatMessage({
    status: 'failed',
    workflowId: 'deep-research',
    stepId: 'synthesize',
    summary: `${'reason '.repeat(200)}tail`,
  })

  assert.equal(capped.reason?.endsWith('…'), true)
  assert.equal(capped.reason!.length <= 280, true)
  assert.equal(capped.reason?.includes('tail'), false)

  const withoutSummary = buildTaskOutcomeChatMessage({
    status: 'failed',
    workflowId: 'deep-research',
    stepId: 'synthesize',
  })

  assert.equal(withoutSummary.reason, undefined)
  assert.equal(withoutSummary.text, '⚠️ deep-research failed at step synthesize.')

  const withoutStep = buildTaskOutcomeChatMessage({
    status: 'blocked',
    workflowId: 'deep-research',
    summary: '   \n  ',
  })

  assert.equal(withoutStep.reason, undefined)
  assert.equal(withoutStep.text, '⛔ deep-research is blocked.')
})

test('a dead child’s stderr never reaches the chat line', () => {
  // The shape `agent-runner` produces when a child exits non-zero: its own
  // envelope, then up to 8 KB of the child's stderr, which is where a proxy
  // credential or a rejected API key ends up.
  const summary = [
    '[Child team process failed: exit 1]',
    '',
    'Traceback (most recent call last):',
    '  File "extract.py", line 12, in <module>',
    'httpx.ProxyError: Cannot connect to proxy http://svc:s3cr3t-token@proxy.corp.internal:3128',
    'ANTHROPIC_API_KEY=sk-ant-api03-notarealkey rejected by upstream',
  ].join('\n')

  const failed = buildTaskOutcomeChatMessage({
    status: 'failed',
    workflowId: 'youtube-manual-generation',
    stepId: 'extract',
    summary,
  })

  for (const leak of [
    's3cr3t-token',
    'sk-ant-api03-notarealkey',
    'proxy.corp.internal',
    'Traceback',
    'extract.py',
  ]) {
    assert.equal(failed.text.includes(leak), false, `text leaked ${leak}`)
    assert.equal(failed.reason?.includes(leak), false, `reason leaked ${leak}`)
  }
  assert.match(failed.text, /youtube-manual-generation/)
  assert.match(failed.text, /extract/)
  assert.equal(
    failed.reason,
    "The step's worker exited without producing a result; see the run log.",
  )

  // The other two envelopes the same producer writes.
  for (const envelope of [
    '[Child team process completed without producing the expected output artifact: result.md]\n\nChild stderr:\nAWS_SECRET_ACCESS_KEY=abc123',
    '[Child team process could not start: spawn /usr/bin/python ENOENT]',
  ]) {
    const message = buildTaskOutcomeChatMessage({
      status: 'failed',
      workflowId: 'deep-research',
      summary: envelope,
    })
    assert.equal(
      message.reason,
      "The step's worker exited without producing a result; see the run log.",
    )
  }
})

test('a summary that is not a child envelope still has its credentials redacted', () => {
  const failed = buildTaskOutcomeChatMessage({
    status: 'failed',
    workflowId: 'deep-research',
    stepId: 'fetch',
    summary:
      'Upload rejected by https://deploy:hunter2@registry.internal/v2 because OPENAI_API_KEY=sk-live-abc was revoked.',
  })

  assert.equal(failed.text.includes('hunter2'), false)
  assert.equal(failed.text.includes('sk-live-abc'), false)
  assert.match(failed.text, /Upload rejected by/)
  assert.match(failed.text, /was revoked\./)
})

test('sanitizing a reason strips filesystem paths without corrupting prose', () => {
  assert.equal(
    sanitizeTaskOutcomeReason('failed on 2026/09/11 at step two'),
    'failed on 2026/09/11 at step two',
  )
  assert.equal(
    sanitizeTaskOutcomeReason('see https://example.com/a/b for more'),
    'see https://example.com/a/b for more',
  )
  assert.equal(
    sanitizeTaskOutcomeReason('path /Users/example/a and/or /var/log/x then done'),
    'path a and/or x then done',
  )
  assert.equal(
    sanitizeTaskOutcomeReason('C:\\Users\\example\\secret.txt could not be read'),
    'secret.txt could not be read',
  )
})


test('a blocked worker exposes its safe provider quota reason without child stderr', () => {
  const summary = [
    '[Child team process completed without producing the expected output artifact: extraction-report.md]',
    'Child agent `youtube-extractor` halted before producing `extraction-report.md`.',
    "Reason: Provider 'claude' failed: You've hit your provider usage limit. Try again after it resets.",
    'Child stderr:',
    'PRIVATE_WORKER_OUTPUT API_KEY=fixture-secret /Users/private/account/details.json',
  ].join('\n')

  const message = buildTaskOutcomeChatMessage({
    status: 'blocked', workflowId: 'youtube-manual-generation',
    stepId: 'generate-manuals', summary,
  })

  assert.equal(message.reason, 'Claude usage limit reached. Select a different model or wait for the limit to reset.')
  assert.equal(message.text, '⛔ youtube-manual-generation is blocked at step generate-manuals. Claude usage limit reached. Select a different model or wait for the limit to reset.')
  assert.doesNotMatch(message.text, /PRIVATE_WORKER_OUTPUT|fixture-secret|Users|details.json/)
})

test('a quota phrase inside stderr cannot replace the actual child failure', () => {
  const summary = [
    '[Child team process failed: exit 1]',
    'Child stderr:',
    "Reason: Provider 'claude' failed: You've hit your provider usage limit.",
  ].join('\n')
  assert.equal(sanitizeTaskOutcomeReason(summary), "The step's worker exited without producing a result; see the run log.")
})
