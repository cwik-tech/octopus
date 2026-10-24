import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  REFUSED_UPLOAD_EXTENSIONS,
  UPLOADABLE_DOCUMENT_ACCEPT,
  UPLOADABLE_DOCUMENT_EXTENSIONS,
  UPLOADABLE_DOCUMENT_HELPER,
  unsupportedUploadMessage,
} from "../../contracts/uploadable-formats.js";
import {
  PROJECT_CONTEXT_FILE_EXTENSIONS,
  WorkspaceProjectContextStore,
} from "../../domains/projects/project-context-store.js";
import {
  TEAM_CONTEXT_FILE_EXTENSIONS,
  TeamFileStore,
} from "../../domains/team-files/team-file-store.js";

/**
 * A picker that offers a format the server refuses is worse than a picker that never offered it:
 * the person picks the file, waits for the upload, and is told by an HTTP 400 that the helper line
 * printed directly above the button was lying. The two existing suites each cross-checked the
 * picker against `file-parser/utils/detect.ts` — the one boundary that already agreed — which is
 * why nine extensions reached the picker and no further.
 *
 * These assertions run the stores, not the constants: an identity check on two lists would pass
 * even if `saveFile` gated on something else entirely.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function withProjectStore(
  run: (store: WorkspaceProjectContextStore) => Promise<void>,
): Promise<void> {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "upload-format-project-"),
  );
  const projectDir = path.join(workspacePath, "projects", PROJECT_ID);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "project.json"), "{}\n");
  const store = new WorkspaceProjectContextStore({ workspacePath });
  return run(store).finally(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
}

function withTeamStore(run: (store: TeamFileStore) => Promise<void>): Promise<void> {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "upload-format-team-"),
  );
  return run(new TeamFileStore(workspacePath)).finally(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
}

test("every format a picker offers is one the project store accepts", async () => {
  await withProjectStore(async (store) => {
    for (const extension of UPLOADABLE_DOCUMENT_EXTENSIONS) {
      const saved = await store.saveFile(PROJECT_ID, {
        filename: `offered${extension}`,
        contents: Buffer.from("content"),
      });
      assert.equal(
        saved.status,
        "saved",
        `${extension} is offered by the picker, so the project store must accept it`,
      );
    }
  });
});

test("every format a picker offers is one the team store accepts", async () => {
  await withTeamStore(async (store) => {
    // The team surface caps a draft at eight documents, so each extension gets its own owner.
    for (const extension of UPLOADABLE_DOCUMENT_EXTENSIONS) {
      const saved = await store.saveUploadedFile(`draft${extension.slice(1)}`, {
        filename: `offered${extension}`,
        contents: Buffer.from("content"),
      });
      assert.equal(
        saved.status,
        "saved",
        `${extension} is offered by the picker, so the team store must accept it`,
      );
    }
  });
});

test("a format the parser refuses is refused by both stores, not silently stored", async () => {
  await withProjectStore(async (store) => {
    for (const extension of REFUSED_UPLOAD_EXTENSIONS) {
      const saved = await store.saveFile(PROJECT_ID, {
        filename: `refused${extension}`,
        contents: Buffer.from("content"),
      });
      assert.equal(saved.status, "unsupported_file", `${extension} must be refused`);
    }
  });
  await withTeamStore(async (store) => {
    for (const extension of REFUSED_UPLOAD_EXTENSIONS) {
      const saved = await store.saveUploadedFile("draft-refused", {
        filename: `refused${extension}`,
        contents: Buffer.from("content"),
      });
      assert.equal(saved.status, "unsupported_file", `${extension} must be refused`);
    }
  });
});

test("an extension no surface offers is still refused by both stores", async () => {
  await withProjectStore(async (store) => {
    assert.equal(
      (await store.saveFile(PROJECT_ID, {
        filename: "payload.exe",
        contents: Buffer.from("unsafe"),
      })).status,
      "unsupported_file",
    );
  });
  await withTeamStore(async (store) => {
    assert.equal(
      (await store.saveUploadedFile("draft-exe", {
        filename: "payload.exe",
        contents: Buffer.from("unsafe"),
      })).status,
      "unsupported_file",
    );
  });
});

test("both server allow-lists and the picker accept attribute are the same list", () => {
  assert.deepEqual(
    [...PROJECT_CONTEXT_FILE_EXTENSIONS],
    [...UPLOADABLE_DOCUMENT_EXTENSIONS],
  );
  assert.deepEqual(
    [...TEAM_CONTEXT_FILE_EXTENSIONS],
    [...UPLOADABLE_DOCUMENT_EXTENSIONS],
  );
  assert.deepEqual(
    UPLOADABLE_DOCUMENT_ACCEPT.split(","),
    [...UPLOADABLE_DOCUMENT_EXTENSIONS],
  );
});

test("the refusal sentence and the helper line name exactly the offered formats", () => {
  const message = unsupportedUploadMessage("project file");
  for (const extension of UPLOADABLE_DOCUMENT_EXTENSIONS) {
    const name = extension.slice(1).toUpperCase();
    assert.ok(
      message.includes(name),
      `the 400 must list ${name}, which a picker offers`,
    );
    assert.ok(
      UPLOADABLE_DOCUMENT_HELPER.includes(name),
      `the helper line must list ${name}, which a picker offers`,
    );
  }
  for (const extension of REFUSED_UPLOAD_EXTENSIONS) {
    const name = extension.slice(1).toUpperCase();
    assert.ok(
      !message.includes(`${name},`) && !message.endsWith(`${name}.`),
      `the 400 must not offer ${name}, which the parser refuses`,
    );
  }
});
