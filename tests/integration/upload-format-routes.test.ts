import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { unsupportedUploadMessage } from "../../contracts/uploadable-formats.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { TeamFileStore } from "../../domains/team-files/team-file-store.js";
import { startApiServer } from "../../server/api-server.js";
import { SourceFileParserLauncher } from "../../core/file-parser-launcher.js";
import type { WorkspaceProject } from "../../contracts/projects.js";

/**
 * The picker's promise, kept over real HTTP.
 *
 * `tests/unit/upload-format-agreement.test.ts` holds the two stores to the offered list. This
 * carries the same question to the boundary a person actually meets: an OpenDocument file the
 * picker offers uploads and parses, and the 400 for a format the parser refuses reads back exactly
 * the sentence the shared constant composes — not a second, hand-maintained summary of it.
 */

// Resolved against the repository root, not this module: these tests run from the compiled tree
// under `.tests-dist`, where no fixture bytes are staged.
const FIXTURES = path.join(process.cwd(), "file-parser", "tests", "fixtures");

function fixture(name: string): Uint8Array<ArrayBuffer> {
  const source = path.join(FIXTURES, name);
  // A fixture that is not on disk would make every assertion below vacuous.
  assert.ok(
    fs.existsSync(source),
    `Fixture not on disk: ${source}. Run \`npm run fixtures\` in file-parser/.`,
  );
  return new Uint8Array(fs.readFileSync(source));
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("the project file route accepts every format its picker offers and refuses the rest in the picker's own words", async () => {
  const workspacePath = makeTempDir("upload-format-project-");
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 0, cwd: "" };
      },
    },
    sessionStore: new FileSystemSessionStore(workspacePath),
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
    workspacePath,
  });

  try {
    const project = (await (
      await fetch(`${server.url}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Mixed formats" }),
      })
    ).json()) as WorkspaceProject;
    const filesUrl = `${server.url}/projects/${project.id}/files`;

    const upload = (filename: string, body: Uint8Array<ArrayBuffer> | string) =>
      fetch(filesUrl, {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(filename) },
        body,
      });

    const openDocument = await upload("field-notes.odt", fixture("field-notes.odt"));
    assert.equal(
      openDocument.status,
      201,
      ".odt is offered by the picker, so the route must take it",
    );
    assert.equal(
      ((await openDocument.json()) as { parseStatus: string }).parseStatus,
      "parsed",
    );

    const markup = await upload("notes.html", "<h1>Launch plan</h1><p>Week two.</p>");
    assert.equal(markup.status, 201, ".html is offered by the picker");
    assert.equal(
      ((await markup.json()) as { parseStatus: string }).parseStatus,
      "parsed",
    );

    const legacy = await upload("legacy-report.doc", fixture("legacy-report.doc"));
    assert.equal(legacy.status, 400);
    assert.equal(
      ((await legacy.json()) as { error: string }).error,
      unsupportedUploadMessage("project file"),
    );

    // Widening the allow-list put markup into a store whose GET route hands the original bytes
    // back on the loopback origin. `contentTypeForFilename` has no entry for .html, so the reply
    // is `application/octet-stream` — and per the MIME Sniffing standard a browser may sniff that
    // into text/html unless told not to. Downloading a shared project file must not be a way to
    // run script against the API origin.
    const download = await fetch(`${filesUrl}/notes.html`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/octet-stream");
    assert.equal(
      download.headers.get("x-content-type-options"),
      "nosniff",
      "an uploaded file is served back as bytes, never as a document to render",
    );
    assert.equal(
      await download.text(),
      "<h1>Launch plan</h1><p>Week two.</p>",
      "the bytes themselves are unchanged",
    );
  } finally {
    await server.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("the team context route accepts every format its picker offers and refuses the rest in the picker's own words", async () => {
  const workspacePath = makeTempDir("upload-format-team-workspace-");
  const repoRootPath = makeTempDir("upload-format-team-repo-");
  fs.mkdirSync(path.join(repoRootPath, "teams"), { recursive: true });
  fs.writeFileSync(path.join(repoRootPath, "teams.yaml"), "");
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    repoRootPath,
    teamFileStore: new TeamFileStore(workspacePath),
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
  });
  const draftId = "draft-upload-formats";

  try {
    const upload = (filename: string, body: Uint8Array<ArrayBuffer> | string) =>
      fetch(`${server.url}/create/team-files/${draftId}/files`, {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(filename) },
        body,
      });

    const spreadsheet = await upload("yield-data.ods", fixture("yield-data.ods"));
    assert.equal(
      spreadsheet.status,
      201,
      ".ods is offered by the picker, so the route must take it",
    );
    assert.equal(
      ((await spreadsheet.json()) as { parseStatus: string }).parseStatus,
      "parsed",
    );

    const configuration = await upload("pipeline.yaml", "steps:\n  - name: collect\n");
    assert.equal(configuration.status, 201, ".yaml is offered by the picker");
    assert.equal(
      ((await configuration.json()) as { parseStatus: string }).parseStatus,
      "parsed",
    );

    const legacy = await upload("legacy-book.xls", fixture("legacy-book.xls"));
    assert.equal(legacy.status, 400);
    assert.equal(
      ((await legacy.json()) as { error: string }).error,
      unsupportedUploadMessage("context document"),
    );
  } finally {
    await server.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRootPath, { recursive: true, force: true });
  }
});
