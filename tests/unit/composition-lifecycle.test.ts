import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredMaxConcurrentToolCalls,
  createCompositionLifecycle,
  type ServiceActivationContext,
} from "../../server/composition.js";
import { MAX_CONCURRENT_TOOL_CALLS_CEILING } from "../../domains/provider/provider-tool-loop.js";

const activationContext: ServiceActivationContext = {
  host: "127.0.0.1",
  port: 4321,
  baseUrl: "http://127.0.0.1:4321",
  publicUrl: "http://127.0.0.1:4321/_pipeline/api-token",
  brokerUrl:
    "http://127.0.0.1:4321/_pipeline/broker-token/settings/provider-execute",
};

test("composition runs pre-listen startup before ordered post-listen activation", async () => {
  const events: string[] = [];
  const lifecycle = createCompositionLifecycle({
    startActions: [
      { name: "provider", run: () => record(events, "start:provider") },
      { name: "mcp", run: () => record(events, "start:mcp") },
      { name: "browser", run: () => record(events, "start:browser") },
    ],
    activationActions: [
      {
        name: "listening",
        run: (context) => {
          assert.deepEqual(context, activationContext);
          events.push("activate:listening");
        },
      },
      { name: "queue", run: () => record(events, "activate:queue") },
      {
        name: "schedule",
        run: () => record(events, "activate:schedule"),
      },
    ],
    resourcesInOwnershipOrder: [],
  });

  await lifecycle.start();
  assert.deepEqual(events, [
    "start:provider",
    "start:mcp",
    "start:browser",
  ]);

  await lifecycle.activateAfterListen(activationContext);
  assert.deepEqual(events, [
    "start:provider",
    "start:mcp",
    "start:browser",
    "activate:listening",
    "activate:queue",
    "activate:schedule",
  ]);
});

test("composition disposes owned resources when pre-listen startup fails", async () => {
  const events: string[] = [];
  const startupFailure = new Error("mcp hydration failed");
  const lifecycle = createCompositionLifecycle({
    startActions: [
      { name: "provider", run: () => record(events, "start:provider") },
      {
        name: "mcp",
        run: () => {
          events.push("start:mcp");
          throw startupFailure;
        },
      },
      { name: "browser", run: () => record(events, "start:browser") },
    ],
    activationActions: [],
    resourcesInOwnershipOrder: resources(events),
  });

  await assert.rejects(
    lifecycle.start(),
    (error) => error === startupFailure,
  );
  assert.deepEqual(events, [
    "start:provider",
    "start:mcp",
    "dispose:third",
    "dispose:second",
    "dispose:first",
  ]);
});

test("composition disposes owned resources when post-listen activation fails", async () => {
  const events: string[] = [];
  const activationFailure = new Error("queue initialization failed");
  const lifecycle = createCompositionLifecycle({
    startActions: [
      { name: "provider", run: () => record(events, "start:provider") },
    ],
    activationActions: [
      {
        name: "listening",
        run: () => record(events, "activate:listening"),
      },
      {
        name: "queue",
        run: () => {
          events.push("activate:queue");
          throw activationFailure;
        },
      },
      {
        name: "schedule",
        run: () => record(events, "activate:schedule"),
      },
    ],
    resourcesInOwnershipOrder: resources(events),
  });

  await lifecycle.start();
  await assert.rejects(
    lifecycle.activateAfterListen(activationContext),
    (error) => error === activationFailure,
  );
  assert.deepEqual(events, [
    "start:provider",
    "activate:listening",
    "activate:queue",
    "dispose:third",
    "dispose:second",
    "dispose:first",
  ]);
});

test("composition disposes in reverse ownership order and isolates failures", async () => {
  const events: string[] = [];
  const disposalFailure = new Error("third close failed");
  const lifecycle = createCompositionLifecycle({
    startActions: [],
    activationActions: [],
    resourcesInOwnershipOrder: [
      {
        name: "first",
        dispose: () => record(events, "dispose:first"),
      },
      {
        name: "second",
        dispose: () => record(events, "dispose:second"),
      },
      {
        name: "third",
        dispose: () => {
          events.push("dispose:third");
          throw disposalFailure;
        },
      },
    ],
  });

  await assert.rejects(
    lifecycle.dispose(),
    (error) => error === disposalFailure,
  );
  assert.deepEqual(events, [
    "dispose:third",
    "dispose:second",
    "dispose:first",
  ]);
});

test("composition disposal is idempotent", async () => {
  let disposalCount = 0;
  const lifecycle = createCompositionLifecycle({
    startActions: [],
    activationActions: [],
    resourcesInOwnershipOrder: [
      {
        name: "resource",
        dispose: async () => {
          await Promise.resolve();
          disposalCount += 1;
        },
      },
    ],
  });

  await Promise.all([lifecycle.dispose(), lifecycle.dispose()]);
  await lifecycle.dispose();
  assert.equal(disposalCount, 1);
});

function resources(events: string[]) {
  return [
    { name: "first", dispose: () => record(events, "dispose:first") },
    { name: "second", dispose: () => record(events, "dispose:second") },
    { name: "third", dispose: () => record(events, "dispose:third") },
  ];
}

function record(events: string[], event: string): void {
  events.push(event);
}

test("composition reads the tool-call pool override only within the accepted range", () => {
  // 1 is the rollback switch to sequential execution.
  assert.equal(configuredMaxConcurrentToolCalls("1"), 1);
  assert.equal(
    configuredMaxConcurrentToolCalls(String(MAX_CONCURRENT_TOOL_CALLS_CEILING)),
    MAX_CONCURRENT_TOOL_CALLS_CEILING,
  );
  // Anything the loop would reject falls back to the loop default instead, so
  // a mistyped variable cannot make every turn throw invalid_configuration.
  for (const ignored of [
    undefined,
    "",
    "0",
    "-1",
    "2.5",
    "four",
    String(MAX_CONCURRENT_TOOL_CALLS_CEILING + 1),
  ]) {
    assert.equal(configuredMaxConcurrentToolCalls(ignored), undefined);
  }
});
