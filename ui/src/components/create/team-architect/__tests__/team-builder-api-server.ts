/// <reference types="node" />
/**
 * A loopback stand-in for the desktop API's Team Builder routes.
 *
 * Tests that use it run the real UI clients against a real HTTP server, so
 * what they observe is what crossed the network: the method, the path, the
 * query and the body of every request. It keeps the backend's revision rule
 * (`server/routes/team-builder.ts` at the A6.2 backend): a write that names a
 * revision the team has moved on from is refused with 409 and the team as it
 * now stands, and a write that names none is applied unchecked.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export const REVISION_CONFLICT_REASON =
  "Someone changed this team. This is how it stands now.";

export interface RecordedRequest {
  method: string;
  /** The path after the API base, without the query. */
  path: string;
  /** The path and query as they arrived, before any decoding. */
  rawPathAndQuery: string;
  query: URLSearchParams;
  body: unknown;
}

export interface StoredTeam {
  id: string;
  description: string;
  members: string[];
  /** The name the list and editor show; the id when absent. */
  name?: string;
  /** The file cannot be read, so its list row carries no revision. */
  unreadable?: boolean;
}

interface TeamState extends StoredTeam {
  version: number;
}

export interface TeamBuilderApiServer {
  /** The API base the UI clients are pointed at. */
  baseUrl: string;
  /** Every request, in the order it arrived. */
  requests: RecordedRequest[];
  /** Starts over with these teams and this Agent catalog. */
  reset(teams: StoredTeam[], agentCatalog: string[]): void;
  /** The team as the server holds it, or undefined once deleted. */
  team(id: string): (StoredTeam & { revision: string }) | undefined;
  /** Someone else changes the team, which moves it to a new revision. */
  changeElsewhere(id: string, change: Partial<Omit<StoredTeam, "id">>): void;
  /**
   * Holds the next request with this method until the returned function is
   * called. `answered` settles once the held request has been answered.
   */
  holdNext(method: string): { release: () => void; answered: Promise<void> };
  close(): Promise<void>;
}

const TOKEN = "a".repeat(43);

function revisionOf(team: TeamState): string {
  // Holds a colon, as the real revision does, so it has to travel encoded.
  return `sha256:${team.id}-${team.version}`;
}

function detailOf(team: TeamState) {
  return {
    id: team.id,
    name: team.name ?? team.id,
    description: team.description,
    tags: [],
    agentCount: team.members.length,
    health: { status: "ok", errors: [], warnings: [] },
    teamPath: `teams/${team.id}/team.yaml`,
    yaml: `team:\n  name: ${team.id}\n`,
    revision: revisionOf(team),
    agents: team.members.map((name) => ({
      name,
      type: "agent",
      role: "Member.",
      tier: "strategic",
      tools: [],
      referenced: true,
    })),
    warnings: [],
  };
}

function summaryOf(team: TeamState) {
  return {
    id: team.id,
    name: team.name ?? team.id,
    description: team.description,
    tags: [],
    agentCount: team.members.length,
    health: { status: "ok", errors: [], warnings: [] },
    // The same revision the detail reports, absent when the file is unreadable.
    ...(team.unreadable ? {} : { revision: revisionOf(team) }),
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startTeamBuilderApiServer(): Promise<TeamBuilderApiServer> {
  const teams = new Map<string, TeamState>();
  let agentCatalog: string[] = [];
  const requests: RecordedRequest[] = [];
  const holds: Array<{ method: string; gate: Promise<void>; done: () => void }> = [];

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  /** The backend's rule for a write that names a revision. */
  const refusedAsStale = (
    response: ServerResponse,
    team: TeamState,
    expectedRevision: unknown,
  ): boolean => {
    if (expectedRevision === undefined || expectedRevision === null) return false;
    if (typeof expectedRevision !== "string" || expectedRevision === "") {
      send(response, 400, { error: "Field expectedRevision must be a non-empty string" });
      return true;
    }
    if (expectedRevision === revisionOf(team)) return false;
    send(response, 409, {
      error: "team_revision_conflict",
      reason: REVISION_CONFLICT_REASON,
      team: detailOf(team),
    });
    return true;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const prefix = `/_pipeline/${TOKEN}`;
    const path = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : url.pathname;
    const method = request.method ?? "GET";
    const body = await readBody(request);
    const rawPathAndQuery = (request.url ?? "").startsWith(prefix)
      ? (request.url ?? "").slice(prefix.length)
      : request.url ?? "";
    requests.push({ method, path, rawPathAndQuery, query: url.searchParams, body });

    const holdIndex = holds.findIndex((hold) => hold.method === method);
    const hold = holdIndex >= 0 ? holds.splice(holdIndex, 1)[0] : undefined;
    if (hold) await hold.gate;
    try {
      route(method, path, url.searchParams, body, response);
    } finally {
      hold?.done();
    }
  };

  const route = (
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    response: ServerResponse,
  ) => {
    if (method === "GET" && path === "/create/team-builder/teams") {
      send(response, 200, { teams: [...teams.values()].map(summaryOf) });
      return;
    }
    if (method === "GET" && path === "/create/agents") {
      send(response, 200, {
        agents: agentCatalog.map((name) => ({
          name,
          description: `${name} description.`,
          skills: [],
          usedInTeams: [],
        })),
      });
      return;
    }
    if (method === "POST" && path === "/create/agents/delete") {
      send(response, 200, { deleted: true });
      return;
    }
    if (method === "GET" && path === "/workflows") {
      send(response, 200, { workflows: [] });
      return;
    }
    const member = /^\/create\/team-builder\/teams\/([^/]+)\/agents\/([^/]+)$/u.exec(path);
    const members = /^\/create\/team-builder\/teams\/([^/]+)\/agents$/u.exec(path);
    const single = /^\/create\/team-builder\/teams\/([^/]+)$/u.exec(path);
    const teamId = decodeURIComponent((member ?? members ?? single)?.[1] ?? "");
    const team = teams.get(teamId);
    if (!team) {
      send(response, 400, { error: `Team not found: ${teamId}` });
      return;
    }
    const bodyRevision = isRecord(body) ? body.expectedRevision : undefined;
    if (single && method === "GET") {
      send(response, 200, { team: detailOf(team) });
      return;
    }
    if (single && method === "PUT") {
      if (refusedAsStale(response, team, bodyRevision)) return;
      if (isRecord(body) && typeof body.description === "string") {
        team.description = body.description;
      }
      team.version += 1;
      send(response, 200, { team: detailOf(team) });
      return;
    }
    if (single && method === "DELETE") {
      if (refusedAsStale(response, team, query.get("expectedRevision") ?? undefined)) return;
      teams.delete(teamId);
      send(response, 200, { deleted: true });
      return;
    }
    if (members && method === "POST") {
      if (refusedAsStale(response, team, bodyRevision)) return;
      if (isRecord(body) && typeof body.agentName === "string") {
        team.members = [...team.members, body.agentName];
      }
      team.version += 1;
      send(response, 200, { team: detailOf(team) });
      return;
    }
    if (member && method === "DELETE") {
      if (refusedAsStale(response, team, query.get("expectedRevision") ?? undefined)) return;
      const name = decodeURIComponent(member[2] ?? "");
      team.members = team.members.filter((candidate) => candidate !== name);
      team.version += 1;
      send(response, 200, { team: detailOf(team) });
      return;
    }
    send(response, 404, { error: `No route for ${method} ${path}` });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      send(response, 500, { error: String(error) });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/_pipeline/${TOKEN}`,
    requests,
    reset(nextTeams, nextCatalog) {
      teams.clear();
      for (const team of nextTeams) {
        teams.set(team.id, { ...team, members: [...team.members], version: 1 });
      }
      agentCatalog = [...nextCatalog];
      requests.length = 0;
      holds.length = 0;
    },
    team(id) {
      const team = teams.get(id);
      return team
        ? { id: team.id, description: team.description, members: [...team.members], revision: revisionOf(team) }
        : undefined;
    },
    changeElsewhere(id, change) {
      const team = teams.get(id);
      if (!team) throw new Error(`No team ${id} to change`);
      if (change.name !== undefined) team.name = change.name;
      if (change.description !== undefined) team.description = change.description;
      if (change.members !== undefined) team.members = [...change.members];
      team.version += 1;
    },
    holdNext(method) {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let done = (): void => {};
      const answered = new Promise<void>((resolve) => {
        done = resolve;
      });
      holds.push({ method, gate, done });
      return { release, answered };
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
