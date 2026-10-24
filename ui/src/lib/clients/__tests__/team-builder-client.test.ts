import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addTeamBuilderAgent,
  createTeamBuilderTeam,
  deleteTeamBuilderTeam,
  invalidateTeamBuilderTeamsCache,
  listCachedTeamBuilderTeams,
  subscribeToTeamBuilderTeams,
  listTeamBuilderTeams,
  changeSavedTeamShape,
  readTeamBuilderTeam,
  removeTeamBuilderAgent,
  TeamRevisionConflictError,
  updateTeamBuilderTeam,
} from "@/lib/clients/team-builder-client";

afterEach(() => {
  invalidateTeamBuilderTeamsCache();
  vi.unstubAllGlobals();
});

function catalogResponse(teamId: string): Response {
  return new Response(
    JSON.stringify({
      teams: [
        {
          id: teamId,
          name: teamId,
          tags: [],
          agentCount: 1,
          agentNames: ["coordinator", "specialist"],
          health: { status: "ok", errors: [], warnings: [] },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function teamMutationResponse(teamId: string): Response {
  return new Response(JSON.stringify({
    team: {
      id: teamId,
      name: teamId,
      tags: [],
      agentCount: 0,
      health: { status: "ok", errors: [], warnings: [] },
      teamPath: `/teams/${teamId}`,
      yaml: `team:\n  name: ${teamId}\n`,
      revision: "sha256:mutation",
      models: {},
      agents: [],
      warnings: [],
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) throw new Error("Deferred promise has no resolver");
      resolvePromise(value);
    },
  };
}

it("rejects malformed Team catalog responses at the HTTP boundary", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          teams: [
            {
              id: 42,
              name: "broken-team",
              tags: [],
              agentCount: 1,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );

  await expect(listTeamBuilderTeams()).rejects.toThrow(
    "Invalid Team catalog response",
  );
});

function rosterCatalogResponse(agents: unknown, extra: object = {}): Response {
  return new Response(
    JSON.stringify({
      teams: [
        {
          id: "board-team",
          name: "board-team",
          tags: [],
          agentCount: 1,
          agentNames: ["board-lead"],
          discussionCoordinator: "board-lead",
          legacyDefaultProvider: "openai",
          legacyModels: {
            orchestration: { model: "gpt-5.4-mini", thinking: "low" },
          },
          health: { status: "ok", errors: [], warnings: [] },
          agents,
          ...extra,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The same object without one key, so a fixture can leave it out. */
function without<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("Team roster runtime layers", () => {
  it("preserves validated Team health diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        rosterCatalogResponse(
          [{ name: "board-lead", type: "agent", tier: "orchestration" }],
          {
            health: {
              status: "error",
              errors: ["Discussion participant 'writer' not found in agent roster"],
              warnings: [],
            },
          },
        ),
      ),
    );

    await expect(listTeamBuilderTeams()).resolves.toEqual([
      expect.objectContaining({
        health: {
          status: "error",
          errors: ["Discussion participant 'writer' not found in agent roster"],
          warnings: [],
        },
      }),
    ]);
  });

  it.each([
    ["an unknown health status", { status: "broken", errors: [], warnings: [] }],
    ["a non-string health error", { status: "error", errors: [42], warnings: [] }],
    ["an ok status with an error", { status: "ok", errors: ["broken"], warnings: [] }],
    ["a warning status with no warning", { status: "warning", errors: [], warnings: [] }],
    ["missing health diagnostics", undefined],
  ])("rejects %s", async (_label, health) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        rosterCatalogResponse(
          [{ name: "board-lead", type: "agent", tier: "orchestration" }],
          { health },
        ),
      ),
    );

    await expect(listTeamBuilderTeams()).rejects.toThrow(
      "Invalid Team catalog response",
    );
  });

  it("returns the roster fields the runtime-selection rule reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        rosterCatalogResponse([
          {
            name: "board-lead",
            type: "agent",
            tier: "orchestration",
            personaProvider: "claude",
          },
        ]),
      ),
    );

    await expect(listTeamBuilderTeams()).resolves.toEqual([
      expect.objectContaining({
        discussionCoordinator: "board-lead",
        // Retired team settings are still decoded so they can be reported as
        // ignored; the roster entry itself carries only the agent's own pair.
        legacyDefaultProvider: "openai",
        agents: [
          {
            name: "board-lead",
            type: "agent",
            tier: "orchestration",
            personaProvider: "claude",
          },
        ],
      }),
    ]);
  });

  it("accepts a roster whose members declare no grade", async () => {
    // Authoring no longer writes one, so a Team created now has a roster with
    // no `tier` anywhere. A client that still required the field would reject
    // the server's own valid response and leave the Team page empty.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        rosterCatalogResponse([
          { name: "board-lead", type: "agent", personaProvider: "claude" },
        ]),
      ),
    );

    await expect(listTeamBuilderTeams()).resolves.toEqual([
      expect.objectContaining({
        agents: [
          { name: "board-lead", type: "agent", personaProvider: "claude" },
        ],
      }),
    ]);
  });

  it.each([
    ["a roster entry that is not an object", ["board-lead"]],
    ["a roster entry with no name", [{ type: "agent", tier: "orchestration" }]],
    [
      "a roster entry with an unknown type",
      [{ name: "board-lead", type: "workflow", tier: "orchestration" }],
    ],
    [
      "a roster entry whose tier is not a string",
      [{ name: "board-lead", type: "agent", tier: 3 }],
    ],
    [
      "a roster entry whose persona provider is not a string",
      [
        {
          name: "board-lead",
          type: "agent",
          tier: "orchestration",
          personaProvider: { id: "openai" },
        },
      ],
    ],
    [
      "a roster entry whose persona model is not a string",
      [
        {
          name: "board-lead",
          type: "agent",
          tier: "orchestration",
          personaModel: 5,
        },
      ],
    ],
    ["a roster that is not a list", { "board-lead": {} }],
  ])("rejects %s", async (_label, agents) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(rosterCatalogResponse(agents)),
    );

    await expect(listTeamBuilderTeams()).rejects.toThrow(
      "Invalid Team catalog response",
    );
  });

  it.each([
    [
      "a legacy tier row that is not an object",
      { legacyModels: { orchestration: "haiku" } },
    ],
    [
      "a legacy tier row with no model",
      { legacyModels: { orchestration: { thinking: "low" } } },
    ],
    [
      "a legacy tier row whose provider is not a string",
      {
        legacyModels: {
          orchestration: { model: "gpt-5.4-mini", thinking: "low", provider: 7 },
        },
      },
    ],
    ["a coordinator name that is not a string", { discussionCoordinator: 1 }],
    [
      "a legacy default provider that is not a string",
      { legacyDefaultProvider: [] },
    ],
  ])("rejects %s", async (_label, extra) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        rosterCatalogResponse(
          [{ name: "board-lead", type: "agent", tier: "orchestration" }],
          extra,
        ),
      ),
    );

    await expect(listTeamBuilderTeams()).rejects.toThrow(
      "Invalid Team catalog response",
    );
  });
});

describe("Team catalog cache", () => {
  it("validates and returns the full Team member list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(catalogResponse("review-team")));

    await expect(listTeamBuilderTeams()).resolves.toEqual([
      expect.objectContaining({
        id: "review-team",
        agentNames: ["coordinator", "specialist"],
      }),
    ]);
  });

  it("deduplicates only an in-flight catalog request and refreshes after it settles", async () => {
    const firstResponse = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementation(async () => catalogResponse("problem-thinking-board"));
    vi.stubGlobal("fetch", fetchMock);

    const firstRequest = listCachedTeamBuilderTeams();
    const secondRequest = listCachedTeamBuilderTeams();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    firstResponse.resolve(catalogResponse("problem-thinking-board"));

    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect(first).toEqual(second);
    await listCachedTeamBuilderTeams();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("notifies mounted readers when the catalog is invalidated", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      catalogResponse("problem-thinking-board")
    );
    vi.stubGlobal("fetch", fetchMock);
    await listCachedTeamBuilderTeams();

    // The Architect builds teams server-side, so a reader that already
    // mounted must be told to refetch rather than serve its first result.
    const listener = vi.fn();
    const unsubscribe = subscribeToTeamBuilderTeams(listener);
    invalidateTeamBuilderTeamsCache();
    await listCachedTeamBuilderTeams();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unsubscribe();
    invalidateTeamBuilderTeamsCache();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not retain a rejected catalog request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ teams: [{ id: 42 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockImplementationOnce(async () => catalogResponse("recovered-team"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listCachedTeamBuilderTeams()).rejects.toThrow(
      "Invalid Team catalog response",
    );
    await expect(listCachedTeamBuilderTeams()).resolves.toEqual([
      expect.objectContaining({ id: "recovered-team" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["create", () => createTeamBuilderTeam({ id: "created-team" })],
    [
      "update",
      () => updateTeamBuilderTeam("existing-team", { id: "updated-team" }),
    ],
    ["delete", () => deleteTeamBuilderTeam("existing-team")],
    [
      "add agent",
      () =>
        addTeamBuilderAgent({
          teamId: "existing-team",
          agentName: "new-agent",
        }),
    ],
    [
      "remove agent",
      () =>
        removeTeamBuilderAgent({
          teamId: "existing-team",
          agentName: "old-agent",
        }),
    ],
  ])("invalidates after a successful %s mutation", async (_label, mutate) => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => catalogResponse("existing-team"))
      .mockImplementationOnce(async () => teamMutationResponse("changed-team"))
      .mockImplementationOnce(async () => catalogResponse("changed-team"));
    vi.stubGlobal("fetch", fetchMock);

    await listCachedTeamBuilderTeams();
    await mutate();
    await expect(listCachedTeamBuilderTeams()).resolves.toEqual([
      expect.objectContaining({ id: "changed-team" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("Team detail response boundary", () => {
  it.each([
    ["read", () => readTeamBuilderTeam("broken-team")],
    ["create", () => createTeamBuilderTeam({ id: "broken-team" })],
    ["update", () => updateTeamBuilderTeam("broken-team", { id: "broken-team" })],
    [
      "add agent",
      () => addTeamBuilderAgent({ teamId: "broken-team", agentName: "writer" }),
    ],
    [
      "remove agent",
      () => removeTeamBuilderAgent({ teamId: "broken-team", agentName: "writer" }),
    ],
  ])("rejects an incomplete %s response", async (_label, request) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ team: { id: "broken-team" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    await expect(request()).rejects.toThrow("Invalid Team detail response");
  });
});

describe("a saved team's shape", () => {
  const detail = {
    id: "contract-review",
    name: "Contract Review",
    description: "Reviews contracts.",
    tags: [],
    agentCount: 2,
    health: { status: "ok", errors: [], warnings: [] },
    teamPath: "./teams/contract-review",
    yaml: "team:\n  name: contract-review\n",
    agents: [],
    warnings: [],
    revision: "sha256:one",
    shape: {
      kind: "chain",
      rationale: "this is how the team is set up now.",
      depth: "quick",
      order: ["risk-lead", "risk-spotter"],
    },
  };

  // The editor decides what to offer from these two, so a reader that drops
  // them leaves it unable to show the shape or to write against it.
  it("carries the shape and the revision the editor writes against", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ team: detail }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const team = await readTeamBuilderTeam("contract-review");

    expect(team.revision).toBe("sha256:one");
    expect(team.shape).toEqual(detail.shape);
  });

  it("refuses a detail whose revision is missing", async () => {
    const withoutRevision = without(detail, "revision");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ team: withoutRevision }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    await expect(readTeamBuilderTeam("contract-review")).rejects.toThrow(
      "Invalid Team detail response",
    );
  });

  it("refuses a shape that is present and is not one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ team: { ...detail, shape: { kind: "huddle" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ));

    await expect(readTeamBuilderTeam("contract-review")).rejects.toThrow(
      "Invalid Team detail response",
    );
  });

  // A refusal is a state of the team, not a failure of the request.
  it("reports a refusal in the server's own words", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "team_revision_conflict",
          reason: "Someone changed this team. Reopen it and try again.",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    ));

    await expect(
      changeSavedTeamShape({
        teamId: "contract-review",
        shape: detail.shape as never,
        expectedRevision: "sha256:one",
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Someone changed this team. Reopen it and try again.",
    });
  });
});

// Every write to a team names the revision the editor loaded, so a change made
// from a stale view is refused instead of overwriting whoever wrote first.
describe("team writes against the revision the editor loaded", () => {
  const TEAM_ID = "contract-review";
  const REFUSAL = "Someone changed this team. This is how it stands now.";
  const teamAsItNowStands = {
    id: TEAM_ID,
    name: "Contract Review",
    description: "Reviews contracts.",
    tags: [],
    agentCount: 0,
    health: { status: "ok", errors: [], warnings: [] },
    teamPath: "./teams/contract-review",
    yaml: "team:\n  name: contract-review\n",
    agents: [],
    warnings: [],
    revision: "sha256:two",
  };
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  type Write = [
    label: string,
    send: (expectedRevision?: string) => Promise<unknown>,
    where: "body" | "query",
    success: () => Response,
  ];
  const writes: Write[] = [
    [
      "saving the details",
      (expectedRevision) =>
        updateTeamBuilderTeam(TEAM_ID, { id: TEAM_ID }, expectedRevision),
      "body",
      () => json(200, { team: teamAsItNowStands }),
    ],
    [
      "deleting the team",
      (expectedRevision) => deleteTeamBuilderTeam(TEAM_ID, expectedRevision),
      "query",
      () => json(200, { deleted: true }),
    ],
    [
      "adding a member",
      (expectedRevision) =>
        addTeamBuilderAgent({ teamId: TEAM_ID, agentName: "writer", expectedRevision }),
      "body",
      () => json(200, { team: teamAsItNowStands }),
    ],
    [
      "removing a member",
      (expectedRevision) =>
        removeTeamBuilderAgent({ teamId: TEAM_ID, agentName: "writer", expectedRevision }),
      "query",
      () => json(200, { team: teamAsItNowStands }),
    ],
  ];

  function stubFetch(response: () => Response) {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function sentRequest(fetchMock: ReturnType<typeof stubFetch>) {
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(input), "http://localhost");
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return { rawUrl: String(input), url, body };
  }

  it.each(writes)("%s sends the loaded revision where the route reads it", async (_label, send, where, success) => {
    const fetchMock = stubFetch(success);

    await send("sha256:one");

    const { rawUrl, url, body } = sentRequest(fetchMock);
    if (where === "body") {
      expect(body).toMatchObject({ expectedRevision: "sha256:one" });
      expect(url.searchParams.has("expectedRevision")).toBe(false);
    } else {
      // The revision holds a colon, so it travels encoded.
      expect(rawUrl).toContain("expectedRevision=sha256%3Aone");
      expect(url.searchParams.get("expectedRevision")).toBe("sha256:one");
    }
  });

  it.each(writes)("%s sends no revision when it was given none", async (_label, send, _where, success) => {
    const fetchMock = stubFetch(success);

    await send(undefined);

    const { url, body } = sentRequest(fetchMock);
    expect(url.searchParams.has("expectedRevision")).toBe(false);
    if (body !== undefined) {
      expect(body).not.toHaveProperty("expectedRevision");
    }
  });

  it.each(writes)("%s reports a refusal as a revision conflict with the team as it now stands", async (_label, send) => {
    stubFetch(() =>
      json(409, { error: "team_revision_conflict", reason: REFUSAL, team: teamAsItNowStands }),
    );

    const refusal = await send("sha256:one").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(TeamRevisionConflictError);
    expect(refusal).toMatchObject({
      message: REFUSAL,
      team: { id: TEAM_ID, revision: "sha256:two" },
    });
  });
});

// The catalog is read through `fetch`, intercepted here at the network edge:
// these cases are the reader's own rule for a row's revision, including rows
// a server keeping to the contract never sends.
describe("a Team catalog row's revision", () => {
  const row = {
    id: "contract-review",
    name: "contract-review",
    tags: [],
    agentCount: 1,
    health: { status: "ok", errors: [], warnings: [] },
  };
  const catalog = (rows: unknown[]): Response =>
    new Response(JSON.stringify({ teams: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("keeps the revision a row was listed with, and gives a row listed without one none", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      catalog([
        { ...row, revision: "sha256:one" },
        { ...row, id: "unreadable", name: "unreadable" },
      ]),
    ));

    const [listed, unreadable] = await listTeamBuilderTeams();

    expect(listed?.revision).toBe("sha256:one");
    expect(unreadable).not.toHaveProperty("revision");
  });

  it.each([
    ["a number", 42],
    ["an empty string", ""],
  ])("refuses a catalog whose row carries a revision that is %s", async (_label, revision) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      catalog([{ ...row, revision }]),
    ));

    await expect(listTeamBuilderTeams()).rejects.toThrow("Invalid Team catalog response");
  });
});
