import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js';
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js';
import { ResourceLibraryService } from '../../services/resource-library-service.js';
import { TaskQueue } from '../../services/task-queue.js';
import { withinBound } from '../support/fixture-process-markers.js';

test('queued tasks launch from their immutable Library root', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-queue-'));
  const repoRoot = path.join(root, 'repo');
  const workspacePath = path.join(root, 'workspace');
  await fs.mkdir(path.join(repoRoot, 'agents/alpha'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'agents/alpha/alpha.md'), '# Alpha\n');
  const store = new FileSystemSessionStore(workspacePath);
  const library = new ResourceLibraryService({ requireMigrationApproval: false, repoRootPath: repoRoot, rootPath: path.join(root, 'library') });
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath });
  let launched = (_root: string) => {};
  const started = new Promise<string>((resolve) => { launched = resolve; });
  const queue = new TaskQueue({ sessionStore: store, owner, maximumConcurrentTasks: 1,
    repoRootPath: repoRoot, workspacePath, resourceLibraryService: library,
    // The external runner boundary reports its admitted root; local queue/store/projection are real.
    taskLauncher: { async startRun(request) { launched(request.env?.TEAM_RUNTIME_REPO_ROOT ?? 'missing'); return { launched: true, pid: 0, cwd: request.cwd }; } },
  });
  try {
    const session = await store.createSession({ title: 'Queued projection' });
    const task = await store.createTaskRecord(session.id, { workflowId: 'projection', brief: '# Work' });
    assert.ok(task);
    await queue.initialize();
    await queue.enqueueRecovery({ sessionId: session.id, taskId: task.id, source: 'manual_resume' });
    const runtimeRoot = await withinBound(started, 7000, 'queue runner launch');
    assert.notEqual(runtimeRoot, repoRoot);
    assert.equal(await fs.readFile(path.join(runtimeRoot, 'agents/alpha/alpha.md'), 'utf8'), '# Alpha\n');
  } finally { await queue.close(); await owner.release(); await fs.rm(root, { recursive: true, force: true }); }
});
