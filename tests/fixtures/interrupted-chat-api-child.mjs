/**
 * A real API process, started so it can be killed.
 *
 * The recovery tests that seed journal state directly prove what recovery does
 * with a given record. They cannot prove that a killed composition leaves that
 * record — which is the claim the whole design rests on. So this is the real
 * server, run in its own process, for the parent to `SIGKILL` mid-turn.
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
import { PiRunLauncher } from "../../.tests-dist/domains/run/run-launcher.js";
import { FileSystemRunStore } from "../../.tests-dist/domains/run/run-store.js";
import { FileSystemSessionStore } from "../../.tests-dist/domains/sessions/session-store.js";
import { ProviderSettingsService } from "../../.tests-dist/services/provider-settings-service.js";

const [workspacePath, projectRoot, providerSettingsPath] = process.argv.slice(2);
if (!workspacePath || !projectRoot || !providerSettingsPath) {
  throw new Error(
    "workspace, project root and provider settings paths are required",
  );
}

const server = await startApiServer({
  store: new FileSystemRunStore(workspacePath),
  launcher: new PiRunLauncher(),
  sessionStore: new FileSystemSessionStore(workspacePath),
  providerSettingsService: new ProviderSettingsService({
    storagePath: providerSettingsPath,
  }),
  workspacePath,
  // The temporary project holding the fixture agent. Agent discovery reads
  // this, so pointing it at the real repository makes every selected-agent
  // turn fail as an unknown agent before a provider is ever reached.
  repoRootPath: projectRoot,
  host: "127.0.0.1",
  port: 0,
});

process.stdout.write(
  `${JSON.stringify({ type: "ready", pid: process.pid, url: server.url })}\n`,
);
// Held open on purpose. The parent decides when this process stops existing.
process.stdin.resume();
