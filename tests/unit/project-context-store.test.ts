import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WorkspaceProjectContextStore } from "../../domains/projects/project-context-store.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function withProjectDirectory(
  run: (store: WorkspaceProjectContextStore, projectDir: string) => Promise<void>,
): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "project-context-"));
  const projectDir = path.join(workspacePath, "projects", PROJECT_ID);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "project.json"), "{}\n");
  const store = new WorkspaceProjectContextStore({ workspacePath });
  return run(store, projectDir).finally(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
}

test("project context store writes an atomic curated brief and removes empty content", async () => {
  await withProjectDirectory(async (store, projectDir) => {
    const brief = await store.saveBrief(PROJECT_ID, "# Stable facts\n\nEU launch");

    assert.equal(brief.content, "# Stable facts\n\nEU launch");
    assert.deepEqual(await store.readBrief(PROJECT_ID), brief);
    assert.equal(await store.hasContent(PROJECT_ID), true);
    assert.equal(
      fs.readFileSync(path.join(projectDir, "context", "brief.md"), "utf8"),
      brief.content,
    );

    const removed = await store.saveBrief(PROJECT_ID, "");
    assert.equal(removed.content, "");
    assert.equal(await store.readBrief(PROJECT_ID), null);
    assert.equal(await store.hasContent(PROJECT_ID), false);
  });
});

test("project context store applies deterministic shared-file policy", async () => {
  await withProjectDirectory(async (store) => {
    const first = await store.saveFile(PROJECT_ID, {
      filename: "z source.md",
      contents: Buffer.from("z"),
    });
    const second = await store.saveFile(PROJECT_ID, {
      filename: "a-source.txt",
      contents: Buffer.from("a"),
    });

    assert.equal(first.status, "saved");
    assert.equal(second.status, "saved");
    assert.deepEqual(
      (await store.listFiles(PROJECT_ID)).map((file) => file.name),
      ["a-source.txt", "z_source.md"],
    );
    assert.equal(
      (await store.readFile(PROJECT_ID, "z_source.md"))?.toString("utf8"),
      "z",
    );
    assert.equal(
      (await store.saveFile(PROJECT_ID, {
        filename: "z source.md",
        contents: Buffer.from("replacement"),
      })).status,
      "duplicate_file",
    );
    assert.equal(
      (await store.saveFile(PROJECT_ID, {
        filename: "script.exe",
        contents: Buffer.from("unsafe"),
      })).status,
      "unsupported_file",
    );
  });
});

test("project context store fails closed for project content symlinks", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link setup requires elevated Windows privileges");
    return;
  }
  await withProjectDirectory(async (store, projectDir) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "project-context-outside-"));
    try {
      fs.symlinkSync(outside, path.join(projectDir, "files"), "dir");

      assert.equal(await store.readFile(PROJECT_ID, "outside.md"), null);
      assert.equal(
        (await store.saveFile(PROJECT_ID, {
          filename: "outside.md",
          contents: Buffer.from("must not escape"),
        })).status,
        "invalid_filename",
      );
      assert.deepEqual(await store.listFiles(PROJECT_ID), []);
      assert.equal(fs.existsSync(path.join(outside, "outside.md")), false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
