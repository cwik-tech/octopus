import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { TeamFileStore } from "../../domains/team-files/team-file-store.js";
import { startApiServer, type StartedApiServer } from "../../server/api-server.js";

/**
 * Characterization of the raw-body upload transport shared by three routes.
 *
 * `server/routes/sessions.ts`, `server/routes/projects.ts`, and
 * `server/routes/team-files.ts` each carry their own copy of the code that
 * reads the `x-filename` header and the request body. These tests pin what a
 * client observes from each copy today, so the copies can be merged without
 * one route drifting from the others.
 *
 * Every filename below goes through the stores' sanitizer, which replaces any
 * run of characters outside `[A-Za-z0-9_.-]` with `_`. The expected names are
 * written out by hand from that rule.
 */

/** 25 MiB plus one byte: the smallest body the routes refuse as too large. */
const OVER_LIMIT_BODY = Buffer.alloc(25 * 1024 * 1024 + 1, "x");

/**
 * How long a raw exchange may wait for the complete reply before failing.
 *
 * Only a failure bound, so a route that stops replying fails the test instead
 * of hanging it. A behaving route answers in milliseconds.
 */
const REPLY_DEADLINE_MS = 5_000;

const idResponseSchema = z.object({ id: z.string() });
const uploadedFileSchema = z.object({ name: z.string() });

interface UploadRoute {
  readonly label: string;
  /** Creates whatever the route requires to exist and returns its upload URL. */
  readonly createUploadUrl: (baseUrl: string) => Promise<string>;
}

const uploadRoutes: readonly UploadRoute[] = [
  {
    label: "session file upload",
    async createUploadUrl(baseUrl) {
      const session = await createResource(`${baseUrl}/sessions`, {
        title: "Upload transport",
      });
      return `${baseUrl}/sessions/${session.id}/files`;
    },
  },
  {
    label: "project file upload",
    async createUploadUrl(baseUrl) {
      const project = await createResource(`${baseUrl}/projects`, {
        name: "Upload transport",
      });
      return `${baseUrl}/projects/${project.id}/files`;
    },
  },
  {
    label: "team file upload",
    // The team-files route keys uploads by a draft owner id and checks no
    // record for it, so there is nothing to create first.
    async createUploadUrl(baseUrl) {
      return `${baseUrl}/create/team-files/draft-${randomUUID()}/files`;
    },
  },
];

let server: StartedApiServer;
let workspacePath: string;
let repoRootPath: string;

before(async () => {
  workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "upload-transport-workspace-"),
  );
  // Every /create/* request, team files included, is refused without a
  // repository root, so the server gets the same minimal one the team-file
  // upload tests use.
  repoRootPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "upload-transport-repo-"),
  );
  fs.mkdirSync(path.join(repoRootPath, "teams"), { recursive: true });
  fs.writeFileSync(path.join(repoRootPath, "teams.yaml"), "");
  server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 0, cwd: "" };
      },
    },
    repoRootPath,
    sessionStore: new FileSystemSessionStore(workspacePath),
    teamFileStore: new TeamFileStore(workspacePath),
    workspacePath,
  });
});

after(async () => {
  await server.close();
  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.rmSync(repoRootPath, { recursive: true, force: true });
});

for (const route of uploadRoutes) {
  test(`${route.label} answers 400 for a missing x-filename header before the body has finished arriving`, async () => {
    const uploadUrl = await route.createUploadUrl(server.url);

    // The client promises two bytes and sends one. A route that read the body
    // before checking the header would still be waiting for the second.
    const reply = await exchange({
      url: uploadUrl,
      method: "POST",
      headers: { "content-length": "2" },
      send: (request) => {
        request.write("a");
      },
      stallMeaning: "the route read the body before validating the header",
    });

    assert.deepEqual(reply, {
      status: 400,
      body: { error: "Missing required header: x-filename" },
    });
  });

  test(`${route.label} stores the file under its percent-decoded x-filename`, async () => {
    const uploadUrl = await route.createUploadUrl(server.url);

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "x-filename": "field%2Dnotes.txt" },
      body: "Survey notes.",
    });

    assert.equal(response.status, 201);
    const body: unknown = await response.json();
    assert.equal(uploadedFileSchema.parse(body).name, "field-notes.txt");
  });

  test(`${route.label} falls back to the raw x-filename when it is not valid percent-encoding`, async () => {
    const uploadUrl = await route.createUploadUrl(server.url);

    // `%A` is a truncated escape, so decodeURIComponent throws a URIError.
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "x-filename": "notes%E0%A4%A.txt" },
      body: "Malformed escape.",
    });

    assert.equal(response.status, 201);
    const body: unknown = await response.json();
    assert.equal(uploadedFileSchema.parse(body).name, "notes_E0_A4_A.txt");
  });

  test(`${route.label} answers 413 for a body one byte over 25 MiB`, async () => {
    const uploadUrl = await route.createUploadUrl(server.url);

    // The reader throws out of its `for await` loop at the first byte over the
    // limit. Node destroys the request stream on that exit but detaches it
    // from the socket first, so the 413 still reaches the client.
    const reply = await exchange({
      url: uploadUrl,
      method: "POST",
      headers: {
        "x-filename": "oversized.txt",
        "content-length": String(OVER_LIMIT_BODY.length),
      },
      send: (request) => {
        request.end(OVER_LIMIT_BODY);
      },
      stallMeaning: "the route stopped reading the oversized body without replying",
    });

    assert.deepEqual(reply, {
      status: 413,
      body: { error: "Upload exceeds 25MB limit" },
    });
  });

  test(`${route.label} collection answers 405 to PUT`, async () => {
    const uploadUrl = await route.createUploadUrl(server.url);

    const response = await fetch(uploadUrl, { method: "PUT" });

    assert.equal(response.status, 405);
    const body: unknown = await response.json();
    assert.deepEqual(body, { error: "Method not allowed" });
  });
}

async function createResource(
  url: string,
  payload: Record<string, string>,
): Promise<{ id: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 201, `creating ${url} must succeed`);
  const body: unknown = await response.json();
  return idResponseSchema.parse(body);
}

interface RawReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * One HTTP exchange that settles on the complete reply, whether or not the
 * request body has finished sending.
 *
 * `fetch` cannot leave a body deliberately unfinished, and the 413 path stops
 * reading mid-body, so both cases drive the request stream directly.
 */
async function exchange(params: {
  readonly url: string;
  readonly method: string;
  readonly headers: http.OutgoingHttpHeaders;
  readonly send: (request: http.ClientRequest) => void;
  /** What a missing reply would mean about the route, for the failure message. */
  readonly stallMeaning: string;
}): Promise<RawReply> {
  const request = http.request(params.url, {
    method: params.method,
    headers: params.headers,
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<RawReply>((resolve, reject) => {
      // A failure bound, not a synchronization point: the reply settles the
      // exchange long before this fires on a route that behaves.
      deadline = setTimeout(() => {
        reject(
          new Error(
            `no response within ${REPLY_DEADLINE_MS} ms: ${params.stallMeaning}`,
          ),
        );
      }, REPLY_DEADLINE_MS);
      request.once("error", reject);
      request.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          try {
            const body: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            resolve({ status: response.statusCode ?? 0, body });
          } catch (error) {
            reject(error);
          }
        });
      });
      params.send(request);
    });
  } finally {
    clearTimeout(deadline);
    // The body may still be unsent. Destroying the request ends the exchange,
    // and an error it raises after the reply arrived says nothing about the
    // route under test.
    request.on("error", () => undefined);
    request.destroy();
  }
}
