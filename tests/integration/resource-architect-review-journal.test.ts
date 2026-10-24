import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { initializeExecutionJournal, readExecutionJournal } from '../../core/execution-journal.js';

const ACTIVITY_ID = '37399bc5-8eb0-4528-b276-35ecbf7d4581';

test('Create feedback activity preserves its own owner without manufacturing a Run session', async () => {
  const scopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-journal-'));
  try {
    const journal = await initializeExecutionJournal({
      scopeRoot,
      identity: {
        scopeKind: 'conversation',
        scopeId: ACTIVITY_ID,
        tenantId: 'local',
        conversationId: 'create-draft-1',
        activityKind: 'turn',
        ...{ ownerKind: 'create-resource-architect' as const },
      },
    });
    await journal.close();
    const read = await readExecutionJournal(scopeRoot);
    assert.equal(read.kind, 'ok');
    assert.ok(read.kind === 'ok');
    assert.equal('sessionId' in read.manifest, false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(scopeRoot, '.runtime/execution-journal/manifest.json'), 'utf8')).ownerKind, 'create-resource-architect');
  } finally {
    await fs.rm(scopeRoot, { recursive: true, force: true });
  }
});

test('Create feedback enrolls a journal when generic Run journaling is disabled', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-registry-'));
  const { WorkspaceConversationJournalRegistry } = await import('../../services/workspace-conversation-journal-registry.js');
  const registry = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' });
  try {
    const lease = await registry.acquire({
      owner: { kind: 'create-resource-architect', conversationId: 'draft-1' },
      activityId: ACTIVITY_ID,
      activityKind: 'turn',
    });
    assert.ok(lease, 'the approved fallback must remain journaled with generic Run journaling off');
    await lease.release();
    assert.equal(await fs.stat(path.join(workspacePath, 'create/conversations/draft-1/.conversation-activities', ACTIVITY_ID)).then(s => s.isDirectory()), true);
    await assert.rejects(fs.stat(path.join(workspacePath, 'sessions')), { code: 'ENOENT' });
  } finally {
    await registry.close();
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

const makeFallback = () => ({
  reviewStatus: 'not_reviewed' as const,
  reviewerId: 'reviewer-of-agent-architect' as const,
  requestedReviewer: { provider: 'codex', model: 'gpt-5.6-sol' },
  actualReviewer: { provider: 'claude', model: 'opus' },
  defaultFallbackAttempted: true,
  failureReason: 'review_output_invalid' as const,
  diagnosticCode: 'schema_invalid',
  failedPhase: 'review' as const,
  phases: [{ phase: 'review' as const, provider: 'claude', model: 'opus', durationMs: 12, startOffsetMs: 4, firstProviderEventMs: null, firstTextMs: null, outcome: 'failed' as const }],
});

test('a fresh reader recovers one disclosed fallback and its actual terminal outcome without private content', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-replay-'));
  const { WorkspaceConversationJournalRegistry } = await import('../../services/workspace-conversation-journal-registry.js');
  const { resolveResourceArchitectJournalRecorder, readResourceArchitectJournal } = await import('../../services/resource-architect-journal-recorder.js');
  const registry = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' });
  const identity = { conversationId: 'draft-1', jobId: 'job-1' };
  try {
    const recorder = await resolveResourceArchitectJournalRecorder({ registry, ...identity });
    await recorder.recordFallback({ ...makeFallback(), ...{ draft: 'PRIVATE_DRAFT', critique: 'PRIVATE_CRITIQUE', rawError: 'SECRET_ERROR' } });
    await recorder.recordFallback(makeFallback());
    await recorder.recordTerminal('cancelled');
    await recorder.release();
    await registry.close();
    const fresh = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' });
    try {
      const read = await readResourceArchitectJournal({ registry: fresh, ...identity });
      assert.equal(read.kind, 'read');
      assert.ok(read.kind === 'read');
      assert.equal(read.eventCount, 2);
      assert.equal(read.terminal, 'cancelled');
      assert.equal(read.fallback?.reason, 'review_output_invalid');
      assert.deepEqual(read.fallback?.requestedReviewer, { provider: 'codex', model: 'gpt-5.6-sol' });
      assert.deepEqual(read.fallback?.attemptedReviewers, [{ provider: 'claude', model: 'opus' }]);
      assert.equal(read.fallback?.proposalSuppressed, true);
      assert.equal(read.fallback?.action, 'return_unreviewed_draft');
      assert.doesNotMatch(JSON.stringify(read), /PRIVATE_DRAFT|PRIVATE_CRITIQUE|SECRET_ERROR/);
      const replay = await resolveResourceArchitectJournalRecorder({ registry: fresh, ...identity });
      await replay.recordFallback(makeFallback());
      await replay.recordTerminal('cancelled');
      await assert.rejects(replay.recordTerminal('completed'), { name: 'ResourceArchitectJournalRecordingError' });
      await replay.release();
      assert.equal((await readResourceArchitectJournal({ registry: fresh, ...identity })).kind, 'read');
    } finally { await fresh.close(); }
  } finally {
    await registry.close();
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test('workspace discovery and authorized inspection find Create fallback evidence after restart', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-discovery-'));
  const { WorkspaceConversationJournalRegistry } = await import('../../services/workspace-conversation-journal-registry.js');
  const { resolveResourceArchitectJournalRecorder } = await import('../../services/resource-architect-journal-recorder.js');
  const { ExecutionJournalInspectionService } = await import('../../services/execution-journal-inspection.js');
  const { ConversationJournalInspectionService } = await import('../../services/conversation-journal-inspection.js');
  const { ADMITS_EVERY_INSPECTION } = await import('../support/journal-inspection-authority.js');
  const registry = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' });
  try {
    const recorder = await resolveResourceArchitectJournalRecorder({ registry, conversationId: 'draft-inspect', jobId: 'job-inspect' });
    await recorder.recordFallback({ ...makeFallback(), failureReason: 'reviewer_unavailable' });
    await recorder.recordTerminal('completed');
    await recorder.release();
    const discovered = await new ExecutionJournalInspectionService({ workspacePath, authority: ADMITS_EVERY_INSPECTION }).discoverJournals();
    assert.equal(discovered.conversationCount, 1);
    assert.equal(discovered.conversationCandidates[0]?.ownerKind, 'create-resource-architect');
    assert.equal(discovered.conversationCandidates[0]?.state, 'enrolled');
    const report = await new ConversationJournalInspectionService({ workspacePath, registry, authority: ADMITS_EVERY_INSPECTION }).inspectCreateConversation({ conversationId: 'draft-inspect' });
    assert.equal(report.kind, 'report');
    assert.ok(report.kind === 'report');
    assert.equal(report.report.ownerKind, 'create-resource-architect');
    assert.equal(report.report.activities[0]?.kind, 'read');
    assert.equal(JSON.stringify(report).includes('reviewer_unavailable'), true);
  } finally {
    await registry.close();
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test('cancellation before the fallback decision records cancellation without an unreviewed publication', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-cancel-'));
  const { WorkspaceConversationJournalRegistry } = await import('../../services/workspace-conversation-journal-registry.js');
  const { resolveResourceArchitectJournalRecorder, readResourceArchitectJournal } = await import('../../services/resource-architect-journal-recorder.js');
  const registry = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' });
  const identity = { conversationId: 'draft-cancel', jobId: 'non-uuid-job:cancel' };
  try {
    const recorder = await resolveResourceArchitectJournalRecorder({ registry, ...identity });
    await recorder.recordTerminal('cancelled');
    await assert.rejects(recorder.recordFallback(makeFallback()), { name: 'ResourceArchitectJournalRecordingError' });
    await recorder.release();
    const read = await readResourceArchitectJournal({ registry, ...identity });
    assert.ok(read.kind === 'read');
    assert.equal(read.eventCount, 1);
    assert.equal(read.terminal, 'cancelled');
    assert.equal(read.fallback, undefined);
  } finally { await registry.close(); await fs.rm(workspacePath, { recursive: true, force: true }); }
});

test('a durability failure rejects the fallback decision instead of silently accepting it', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-durability-'));
  const { WorkspaceConversationJournalRegistry } = await import('../../services/workspace-conversation-journal-registry.js');
  const { resolveResourceArchitectJournalRecorder, resourceArchitectJournalActivityId } = await import('../../services/resource-architect-journal-recorder.js');
  const registry = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' });
  try {
    const recorder = await resolveResourceArchitectJournalRecorder({ registry, conversationId: 'draft-write-failure', jobId: 'job-write-failure' });
    const activity = resourceArchitectJournalActivityId('job-write-failure');
    const manifest = path.join(workspacePath, 'create/conversations/draft-write-failure/.conversation-activities', activity, '.runtime/execution-journal/manifest.json');
    await fs.rename(manifest, `${manifest}.unavailable`);
    await assert.rejects(recorder.recordFallback(makeFallback()), { name: 'ExecutionJournalError' });
    await recorder.release();
  } finally { await registry.close(); await fs.rm(workspacePath, { recursive: true, force: true }); }
});

test('Create inspection applies the existing authority before testing whether a conversation exists', async () => {
  const { ConversationJournalInspectionService } = await import('../../services/conversation-journal-inspection.js');
  const denied = new ConversationJournalInspectionService({ workspacePath: '/path-that-does-not-exist', authority: { authorize: async () => false } });
  await assert.rejects(denied.inspectCreateConversation({ conversationId: 'draft-denied' }), { name: 'ExecutionJournalAuthorizationError' });
});

test('a failed publication supersedes server completion without deleting either journal fact', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-publish-'));
  const { WorkspaceConversationJournalRegistry } = await import('../../services/workspace-conversation-journal-registry.js');
  const { resolveResourceArchitectJournalRecorder, readResourceArchitectJournal } = await import('../../services/resource-architect-journal-recorder.js');
  const registry = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'local', mode: 'disabled' });
  const identity = { conversationId: 'draft-publish', jobId: 'job-publish' };
  try {
    const recorder = await resolveResourceArchitectJournalRecorder({ registry, ...identity });
    await recorder.recordFallback(makeFallback());
    await recorder.recordTerminal('completed');
    await recorder.recordPublicationFailed();
    await recorder.recordPublicationFailed();
    await recorder.release();
    const read = await readResourceArchitectJournal({ registry, ...identity });
    assert.ok(read.kind === 'read');
    assert.equal(read.eventCount, 3);
    assert.equal(read.terminal, 'failed');
    assert.equal(read.serverTerminal, 'completed');
    assert.equal(read.publicationFailed, true);
  } finally { await registry.close(); await fs.rm(workspacePath, { recursive: true, force: true }); }
});
