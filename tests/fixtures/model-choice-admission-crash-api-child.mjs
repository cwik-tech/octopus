/**
 * A real API process, started so it can be killed mid-approval.
 *
 * Nothing here is a test double except the launcher, which settles immediately
 * because starting a worker is outside what this fixture exists to prove. The
 * session store, the task queue, the workflow store, the route and every lock
 * are the real ones — the crash window this reproduces lives between two of
 * their writes, so replacing any of them would reproduce something else.
 *
 * The parent creates the window by holding the task's own `.task.lock`, which
 * is the same lock the real compare-and-set takes. This process therefore
 * commits the approval and then blocks on that lock exactly as it would behind
 * any other writer, and the parent kills it there.
 *
 * Plain JavaScript against the compiled output, rather than TypeScript loaded
 * through `tsx`. The loader would put an esbuild service beside this process,
 * and `SIGKILL` — the signal this fixture exists to receive — is exactly the
 * one that leaves such a helper behind.
 *
 * There is deliberately no shutdown path: a process that could tidy up after
 * itself is not the one being reproduced.
 */
import { startApiServer } from "../../.tests-dist/server/api-server.js";
import { FileSystemRunStore } from "../../.tests-dist/domains/run/run-store.js";
import { FileSystemSessionStore } from "../../.tests-dist/domains/sessions/session-store.js";
import { setRuntimeDefaultModelState } from "../../.tests-dist/domains/provider/default-model-selection.js";

const [workspacePath, projectRoot, defaultProvider, defaultModel] =
  process.argv.slice(2);
if (!workspacePath || !projectRoot || !defaultProvider || !defaultModel) {
  throw new Error(
    "workspace, project root, default provider and default model are required",
  );
}

/** Settles, so nothing in this process waits on a promise that cannot. */
class SettlingLauncher {
  async startRun() {
    return { launched: true, pid: process.pid, cwd: workspacePath };
  }
}

const server = await startApiServer({
  store: new FileSystemRunStore(workspacePath),
  launcher: new SettlingLauncher(),
  taskLauncher: new SettlingLauncher(),
  sessionStore: new FileSystemSessionStore(workspacePath),
  workspacePath,
  repoRootPath: projectRoot,
  host: "127.0.0.1",
  port: 0,
});

// Set after the server is up, not before: the composition hydrates the runtime
// default from provider settings while it boots, and this process has no
// Settings for it to read. The approval route revalidates the offered pair
// against this, so without it every approval is refused for want of a default.
setRuntimeDefaultModelState({
  status: "available",
  provider: defaultProvider,
  model: defaultModel,
});

process.stdout.write(
  `${JSON.stringify({ type: "ready", pid: process.pid, url: server.url })}\n`,
);
// Held open on purpose. The parent decides when this process stops existing.
process.stdin.resume();
