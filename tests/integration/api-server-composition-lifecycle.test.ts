import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { startApiServer } from "../../server/api-server.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";

test("activation failure closes the socket and releases dispatcher ownership", async () => {
  const workspacePath = makeWorkspace();
  const activationFailure = new Error("activation failed");
  let listeningUrl: string | undefined;

  try {
    await assert.rejects(
      startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher,
        sessionStore: new FileSystemSessionStore(workspacePath),
        workspacePath,
        onListening: async ({ url }) => {
          listeningUrl = url;
          const health = await fetch(`${url}/health`);
          assert.equal(health.status, 200);
          throw activationFailure;
        },
      }),
      (error) => error === activationFailure,
    );

    assert.ok(listeningUrl);
    await assert.rejects(fetch(`${listeningUrl}/health`));

    const replacement = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher,
      sessionStore: new FileSystemSessionStore(workspacePath),
      workspacePath,
    });
    await replacement.close();
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("listen failure disposes the service graph and releases dispatcher ownership", async () => {
  const workspacePath = makeWorkspace();
  const blocker = http.createServer();
  await listen(blocker);
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");

  try {
    await assert.rejects(
      startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher,
        sessionStore: new FileSystemSessionStore(workspacePath),
        workspacePath,
        host: "127.0.0.1",
        port: address.port,
      }),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "EADDRINUSE",
    );

    const replacement = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher,
      sessionStore: new FileSystemSessionStore(workspacePath),
      workspacePath,
    });
    await replacement.close();
  } finally {
    await close(blocker);
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

const launcher = {
  async startRun(request: { cwd: string }) {
    return { launched: true as const, pid: 1, cwd: request.cwd };
  },
};

function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "composition-lifecycle-")),
  );
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
