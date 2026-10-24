import assert from "node:assert/strict";
import type * as http from "node:http";
import test from "node:test";

import {
  dispatchRoutes,
  projectRouteInventory,
  type RouteContext,
  type RouteRegistration,
} from "../../server/routing.js";

const context: RouteContext<undefined> = {
  req: {} as http.IncomingMessage,
  res: {} as http.ServerResponse,
  url: new URL("http://127.0.0.1/example"),
  services: undefined,
};

test("route dispatch preserves declaration order within a stage", async () => {
  const calls: string[] = [];
  const routes = [
    registration("first", async () => {
      calls.push("first");
      return false;
    }),
    registration("second", () => {
      calls.push("second");
      return false;
    }),
    registration("third", () => {
      calls.push("third");
      return false;
    }),
  ];

  assert.equal(await dispatchRoutes({ routes, stage: "api", context }), false);
  assert.deepEqual(calls, ["first", "second", "third"]);
});

test("route dispatch invokes only registrations in the requested stage", async () => {
  const calls: string[] = [];
  const routes = [
    registration("capability", () => {
      calls.push("capability");
      return true;
    }, { stage: "pre-auth-capability" }),
    registration("api", () => {
      calls.push("api");
      return true;
    }),
  ];

  assert.equal(await dispatchRoutes({ routes, stage: "api", context }), true);
  assert.deepEqual(calls, ["api"]);
});

test("route dispatch short-circuits after the first handled route", async () => {
  const calls: string[] = [];
  const routes = [
    registration("miss", () => {
      calls.push("miss");
      return false;
    }),
    registration("handled", () => {
      calls.push("handled");
      return true;
    }),
    registration("unreached", () => {
      calls.push("unreached");
      return true;
    }),
  ];

  assert.equal(await dispatchRoutes({ routes, stage: "api", context }), true);
  assert.deepEqual(calls, ["miss", "handled"]);
});

test("route dispatch reports an unhandled stage without registrations", async () => {
  const routes = [
    registration("capability", () => true, {
      stage: "pre-auth-capability",
    }),
  ];

  assert.equal(await dispatchRoutes({ routes, stage: "api", context }), false);
});

test("route inventory is an immutable projection detached from registration metadata", () => {
  const methods = ["GET"];
  const path = { kind: "exact", path: "/health" } as const;
  const routes = [
    registration("health", () => true, { methods, path }),
  ];

  const inventory = projectRouteInventory(routes);
  methods.push("POST");

  assert.ok(Object.isFrozen(inventory));
  assert.ok(Object.isFrozen(inventory[0]));
  assert.ok(Object.isFrozen(inventory[0]?.methods));
  assert.ok(Object.isFrozen(inventory[0]?.path));
  assert.deepEqual(inventory[0]?.methods, ["GET"]);
});

test("route inventory preserves exact, prefix, and pattern metadata", () => {
  const routes: RouteRegistration<undefined>[] = [
    registration("health", () => true, {
      authorization: "public",
      methods: ["GET"],
      path: { kind: "exact", path: "/health" },
    }),
    registration("sessions", () => true, {
      methods: ["GET", "POST", "PATCH", "DELETE"],
      path: { kind: "prefix", prefix: "/sessions" },
    }),
    registration("run-detail", () => true, {
      streaming: "sse",
      methods: ["GET"],
      path: {
        kind: "pattern",
        pattern: "^/runs/[^/]+/events$",
      },
    }),
  ];

  assert.deepEqual(projectRouteInventory(routes), [
    {
      order: 0,
      id: "health",
      stage: "api",
      authorization: "public",
      streaming: "none",
      methods: ["GET"],
      path: { kind: "exact", path: "/health" },
    },
    {
      order: 1,
      id: "sessions",
      stage: "api",
      authorization: "api",
      streaming: "none",
      methods: ["GET", "POST", "PATCH", "DELETE"],
      path: { kind: "prefix", prefix: "/sessions" },
    },
    {
      order: 2,
      id: "run-detail",
      stage: "api",
      authorization: "api",
      streaming: "sse",
      methods: ["GET"],
      path: {
        kind: "pattern",
        pattern: "^/runs/[^/]+/events$",
      },
    },
  ]);
});

function registration(
  id: string,
  handler: RouteRegistration<undefined>["handler"],
  overrides: Partial<
    Pick<
      RouteRegistration<undefined>,
      "stage" | "authorization" | "streaming" | "methods" | "path"
    >
  > = {},
): RouteRegistration<undefined> {
  return {
    id,
    stage: "api",
    authorization: "api",
    streaming: "none",
    methods: ["GET"],
    path: { kind: "exact", path: `/${id}` },
    handler,
    ...overrides,
  };
}
