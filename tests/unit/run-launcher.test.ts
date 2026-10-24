import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  launchDetachedProcess,
  type DetachedProcess,
  type SpawnDetachedProcess,
} from "../../domains/run/run-launcher.js";

function fakeDetachedProcess(pid?: number): {
  child: DetachedProcess;
  emitter: EventEmitter;
  wasUnrefCalled(): boolean;
} {
  const emitter = new EventEmitter();
  let unrefCalled = false;
  const child = {
    pid,
    once(event: string, listener: (...args: unknown[]) => void) {
      emitter.once(event, listener);
      return child;
    },
    unref() {
      unrefCalled = true;
    },
  } as unknown as DetachedProcess;
  return { child, emitter, wasUnrefCalled: () => unrefCalled };
}

test("launchDetachedProcess waits for spawn acknowledgement before resolving", async () => {
  const fake = fakeDetachedProcess(4321);
  const { child } = fake;
  const spawnProcess: SpawnDetachedProcess = () => child;
  const launched = launchDetachedProcess({
    command: "worker",
    args: ["--run"],
    options: { detached: true, stdio: "ignore" },
    spawnProcess,
  });

  assert.equal(fake.wasUnrefCalled(), false);
  fake.emitter.emit("spawn");
  assert.equal(await launched, 4321);
  assert.equal(fake.wasUnrefCalled(), true);
});

test("launchDetachedProcess rejects operating-system launch errors", async () => {
  const fake = fakeDetachedProcess();
  const { child } = fake;
  const spawnProcess: SpawnDetachedProcess = () => child;
  const launched = launchDetachedProcess({
    command: "missing-worker",
    args: [],
    options: { detached: true, stdio: "ignore" },
    spawnProcess,
  });

  fake.emitter.emit("error", new Error("ENOENT"));
  await assert.rejects(launched, /Failed to launch missing-worker: ENOENT/);
  assert.equal(fake.wasUnrefCalled(), false);
});
