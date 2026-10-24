import { whenDefined } from '../../core/optional-properties.js'
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import {
  createApiRouteInventory,
  type ApiRouteServices,
} from "../../server/route-table.js";
import type { RouteRegistration } from "../../server/routing.js";
import type { RegisteredToolContribution } from "../../server/tools/tool-registry.js";

/**
 * Divergences from the frozen commit-87ad988 inventory, each one reviewed.
 *
 * `pre-route-table-inventory.json` is a provenance record: it asserts it was
 * derived from a named commit of `server/api-server.ts`, and editing it would
 * make that claim false. So the fixture stays exactly as it is, and every
 * intentional change since that commit is listed here instead. A change that
 * is not listed still fails the comparison, which is the point.
 */
const INTENTIONAL_DRIFT: readonly RouteInventoryDrift[] = [
  {
    id: "sessions",
    since: "2026-08-24",
    why:
      "The /sessions prefix now stands in front of two SSE endpoints — the " +
      "agent-chat text stream and Deep Research planning — while its other " +
      "endpoints answer with plain JSON. Neither 'none' nor 'sse' describes " +
      "that: one denies the streams, the other claims the rest stream too.",
    from: { streaming: "none" },
    to: { streaming: "mixed" },
  },
  {
    id: "resource-architect",
    since: "2026-09-13",
    why:
      "A proposed Team now states how its members will work together, and the " +
      "user can disagree with it. That needs one endpoint addressed by plan " +
      "rather than by job, so the prefix gained `plans/:planId/shape`. It is " +
      "the same authorization and the same handler as the rest of the prefix. " +
      "A build's unfinished Team can also now be thrown away, which is the " +
      "same shape of addition under `jobs/:jobId/discard`.",
    from: {
      path: {
        kind: "pattern",
        pattern:
          "^/create/resource-architect/(?:turn|metrics|jobs(?:/[^/]+(?:/retry)?)?)$",
      },
    },
    to: {
      path: {
        kind: "pattern",
        pattern:
          "^/create/resource-architect/(?:turn|metrics|jobs(?:/[^/]+(?:/retry|/discard)?)?|plans/[^/]+/shape)$",
      },
    },
  },
  {
    id: "team-builder",
    since: "2026-09-14",
    why:
      "A team that already exists can now be told to work together a different " +
      "way, which needs one endpoint addressed by team rather than by member. " +
      "Same authorization and same handler as the rest of the prefix.",
    from: {
      path: {
        kind: "pattern",
        pattern: "^/create/team-builder/teams(?:/[^/]+(?:/agents(?:/[^/]+)?)?)?$",
      },
    },
    to: {
      path: {
        kind: "pattern",
        pattern:
          "^/create/team-builder/teams(?:/[^/]+(?:/agents(?:/[^/]+)?|/shape)?)?$",
      },
    },
  },
  {
    id: "batch-folder-grants",
    since: "2026-10-08",
    why:
      "Settings now also lists and revokes the grants for folders shared with " +
      "agents, which a security review kept in a list of their own. That is a " +
      "second exact path, `/settings/shared-folder-grants`, with the same " +
      "methods, authorization and status codes as the Batch one, so this entry " +
      "serves both rather than adding a route and renumbering every one after it.",
    from: {
      path: { kind: "exact", path: "/settings/batch-folder-grants" },
    },
    to: {
      path: {
        kind: "pattern",
        pattern: "^/settings/(?:batch|shared)-folder-grants$",
      },
    },
  },
];

test("API route inventory matches the frozen pre-route-table contract, modulo reviewed drift", () => {
  const inventory = createApiRouteInventory(routeServicesWithCapabilities());

  assert.deepEqual(inventory, expectedRouteInventory());

  assert.ok(
    indexOf(inventory, "browser-settings-and-activity") <
      indexOf(inventory, "sessions"),
  );
  assert.ok(indexOf(inventory, "mcp-resources") < indexOf(inventory, "sessions"));
  assert.ok(
    indexOf(inventory, "mcp-interactions") < indexOf(inventory, "sessions"),
  );
  assert.ok(indexOf(inventory, "batches") > indexOf(inventory, "schedules"));
  assert.ok(
    indexOf(inventory, "batch-folder-grants") >
      indexOf(inventory, "scheduling-settings"),
  );
});

test("API route inventory omits unavailable private capabilities", () => {
  const services = routeServicesWithCapabilities();
  const {
    mcpWorkerTurnService: _mcpWorkerTurnService,
    mcpWorkerTurnPath: _mcpWorkerTurnPath,
    ...compositionWithoutPrivateCapabilities
  } = services.composition
  const inventory = createApiRouteInventory({
    ...services,
    composition: {
      ...compositionWithoutPrivateCapabilities,
      toolContributions: services.composition.toolContributions.map(
        (contribution) => ({
          ...contribution,
          routes: contribution.routes.filter(
            (route) => route.stage === "api",
          ),
        }),
      ),
    },
  });

  assert.equal(
    inventory.some((route) => route.stage === "pre-auth-capability"),
    false,
  );
  assert.equal(inventory[0]?.order, 0);
  assert.equal(inventory[0]?.id, "health");
  assert.equal(inventory[1]?.order, 1);
  assert.equal(inventory[1]?.id, "deep-research-settings");
});

test("API route inventory records Create's missing-root interception", () => {
  const services = routeServicesWithCapabilities();
  const inventory = createApiRouteInventory({
    ...services,
    options: {} as ApiRouteServices["options"],
  });
  assert.deepEqual(
    inventory.find((route) => route.id === "create-support")?.path,
    prefix("/create/"),
  );
});

test("API route inventory omits the legacy Create planning routes", () => {
  const routeIds = createApiRouteInventory(routeServicesWithCapabilities()).map(
    (route) => route.id,
  );

  assert.equal(routeIds.includes("create-orchestrator"), false);
  assert.equal(routeIds.includes("team-architect"), false);
});

function routeServicesWithCapabilities(): ApiRouteServices {
  return {
    options: {
      repoRootPath: "/repo",
    } as ApiRouteServices["options"],
    eventPollIntervalMs: 250,
    composition: {
      mcpWorkerTurnService: {},
      mcpWorkerTurnPath: "/_worker/test",
      toolContributions: toolContributionsWithCapabilities(),
    } as ApiRouteServices["composition"],
  };
}

function toolContributionsWithCapabilities():
  readonly RegisteredToolContribution[] {
  // Deliberately retain service-construction order (YouTube before Browser).
  // Route precedence comes from each contribution's generic routeOrder.
  return [
    toolContribution("youtube", 1, [
      toolRoute(
        "youtube-settings",
        "api",
        ["GET", "PATCH", "POST"],
        pattern("^/settings/youtube(?:/validate|/gemini/(?:validate|models))?$"),
      ),
      toolRoute(
        "youtube-tool-capability",
        "pre-auth-capability",
        ["POST"],
        exact("/_youtube/test"),
      ),
    ]),
    toolContribution("browser", 0, [
      toolRoute(
        "browser-settings-and-activity",
        "api",
        ["GET", "PUT", "POST"],
        pattern(
          "^(?:/settings/browser(?:/(?:open-profile|stop))?|/sessions/[^/]+/browser-activity(?:/favicon|/[^/]+/attachment)?)$",
        ),
      ),
      toolRoute(
        "browser-tool-capability",
        "pre-auth-capability",
        ["POST"],
        exact("/_browser/test"),
      ),
    ]),
    toolContribution("generate-word", 2, [
      toolRoute(
        "generate-word-tool-capability",
        "pre-auth-capability",
        ["POST"],
        exact("/_word/test"),
      ),
    ]),
    toolContribution("generate-excel", 3, [
      toolRoute(
        "generate-excel-tool-capability",
        "pre-auth-capability",
        ["POST"],
        exact("/_excel/test"),
      ),
    ]),
  ];
}

function toolContribution(
  name: string,
  routeOrder: number,
  routes: readonly RouteRegistration[],
): RegisteredToolContribution {
  return { name, routeOrder, services: {}, routes };
}

function toolRoute(
  id: string,
  stage: RouteRegistration["stage"],
  methods: readonly string[],
  path: RouteRegistration["path"],
): RouteRegistration {
  return {
    id,
    stage,
    authorization: stage === "api" ? "api" : "capability",
    streaming: "none",
    methods,
    path,
    handler: () => false,
  };
}

interface RouteInventoryDrift {
  /** The route entry this divergence applies to. */
  readonly id: string;
  /** When it was reviewed and accepted. */
  readonly since: string;
  /** Why the frozen value is no longer the right one. */
  readonly why: string;
  /** The fields as the frozen fixture records them. Must still match. */
  readonly from: Readonly<Record<string, unknown>>;
  /** The fields the live inventory is expected to carry instead. */
  readonly to: Readonly<Record<string, unknown>>;
}

/**
 * The frozen inventory with each reviewed divergence applied, so the
 * comparison above stays an exact match against a stated expectation rather
 * than a loosened one. A drift whose `from` no longer matches the fixture is
 * a stale entry and fails here rather than silently masking a real change.
 */
function applyDrift(
  frozen: unknown,
  drifts: readonly RouteInventoryDrift[],
): unknown {
  assert.ok(Array.isArray(frozen), "the frozen inventory must be an array");
  const applied = new Set<string>();
  const drifted = frozen.map((entry: unknown) => {
    assert.ok(
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
      "every frozen inventory entry must be an object",
    );
    const record: Record<string, unknown> = { ...entry };
    const drift = drifts.find((candidate) => candidate.id === record.id);
    if (!drift) return record;
    for (const [key, value] of Object.entries(drift.from)) {
      assert.deepEqual(
        record[key],
        value,
        `Drift "${drift.id}" (since ${drift.since}) expects the frozen ` +
          `inventory to still record ${key}=${JSON.stringify(value)}. It does ` +
          `not, so this entry is stale and is hiding a real change.`,
      );
    }
    applied.add(drift.id);
    return { ...record, ...drift.to };
  });
  for (const drift of drifts) {
    assert.ok(
      applied.has(drift.id),
      `Drift "${drift.id}" names a route the frozen inventory does not contain.`,
    );
  }
  return drifted;
}

function expectedRouteInventory(): unknown {
  const drifted = applyDrift(legacyRouteInventory(), INTENTIONAL_DRIFT);
  assert.ok(Array.isArray(drifted));
  const routes = [...drifted];
  const insertionIndex = routes.findIndex((entry: unknown) =>
    typeof entry === "object" && entry !== null && "id" in entry && entry.id === "projects"
  );
  assert.ok(insertionIndex >= 0, "the frozen Projects route must remain present");
  // Reviewed 2026-10-18: Library catalog, revision and attachment endpoints
  // use the same API authorization as Projects.
  routes.splice(insertionIndex, 0, {
    order: insertionIndex,
    id: "resource-library",
    stage: "api",
    authorization: "api",
    streaming: "none",
    methods: ["GET", "POST", "PATCH", "DELETE"],
    path: { kind: "pattern", pattern: "^/resource-library(?:$|/.*$)" },
  });
  return routes.map((entry: unknown, index: number) => {
    assert.ok(typeof entry === "object" && entry !== null && !Array.isArray(entry));
    return { ...entry, order: index };
  });
}

function legacyRouteInventory(): unknown {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "api",
        "pre-route-table-inventory.json",
      ),
      "utf8",
    ),
  ) as { readonly derivedFrom?: unknown; readonly routes?: unknown };
  assert.equal(
    fixture.derivedFrom,
    "87ad988abacda29b6066227edb63d88bdbac7311:server/api-server.ts",
  );
  return fixture.routes;
}

function exact(path: string) {
  return { kind: "exact" as const, path };
}

function prefix(value: string) {
  return { kind: "prefix" as const, prefix: value };
}

function pattern(value: string) {
  return { kind: "pattern" as const, pattern: value };
}

function indexOf(
  inventory: ReturnType<typeof createApiRouteInventory>,
  id: string,
): number {
  return inventory.findIndex((route) => route.id === id);
}

test("the display-frame ingest route exists only where a token registry does", () => {
  // Gated on the registry rather than always present, so a deployment that
  // never issues a delta token has no ingest endpoint at all rather than an
  // unguarded one. This is also why the frozen inventory above, whose services
  // configure no registry, still matches exactly.
  const withoutRegistry = createApiRouteInventory(routeServicesWithCapabilities());
  assert.equal(
    withoutRegistry.some((route) => route.id === "agent-text-stream-ingest"),
    false,
  );

  const services = routeServicesWithCapabilities();
  const withRegistry = createApiRouteInventory({
    ...services,
    composition: {
      ...services.composition,
      agentTextStreamDeltaTokens: {},
    } as ApiRouteServices["composition"],
  });
  const ingest = withRegistry.find(
    (route) => route.id === "agent-text-stream-ingest",
  );
  assert.ok(ingest, "the ingest route was not registered");
  // Reached before the token-in-path check, because the credential is a
  // header. Its path is fixed and public and carries no secret.
  assert.equal(ingest.stage, "pre-auth-capability");
  assert.equal(ingest.authorization, "capability");
  assert.deepEqual(ingest.methods, ["POST"]);
  assert.deepEqual(ingest.path, exact("/internal/agent-text-stream"));
});
