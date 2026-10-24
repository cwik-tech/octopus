import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { FileSourceRepository } from "../../domains/file-sources/file-source-repository.js";

test("file source repository saves, lists, reads, and removes parsed source state", async () => {
  const ownerDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-source-repo-"));
  const rootDir = path.join(ownerDir, "inputs");
  const repository = new FileSourceRepository({
    rootDir,
    containmentRoot: ownerDir,
  });

  try {
    const saved = await repository.save(
      "brief.docx",
      Buffer.from("binary"),
      { overwrite: false },
    );
    assert.equal(saved.status, "saved");
    assert.equal((await repository.list())[0]?.parseStatus, "pending");

    const parsedDir = path.join(rootDir, "parsed");
    await fs.mkdir(parsedDir);
    await fs.writeFile(path.join(parsedDir, "brief.docx.md"), "Parsed brief");
    await fs.writeFile(
      path.join(parsedDir, "_manifest.json"),
      `${JSON.stringify({
        generated_at: "2026-07-24T12:00:00.000Z",
        parser_version: "test",
        files: [
          {
            source: "brief.docx",
            status: "success",
            outputs: { text: "brief.docx.md" },
            custom_field: "preserved",
          },
        ],
      })}\n`,
    );

    const [parsed] = await repository.list();
    assert.equal(parsed?.parseStatus, "parsed");
    assert.equal(parsed?.parsedAt, "2026-07-24T12:00:00.000Z");
    assert.equal(
      await repository.readParsedText("brief.docx.md"),
      "Parsed brief",
    );
    assert.equal(await repository.delete("brief.docx"), true);
    assert.deepEqual(await repository.list(), []);
    await assert.rejects(fs.stat(path.join(parsedDir, "brief.docx.md")), {
      code: "ENOENT",
    });
    const manifest = await repository.readManifest();
    assert.equal(manifest?.parser_version, "test");
    assert.deepEqual(manifest?.files, []);
  } finally {
    await fs.rm(ownerDir, { recursive: true, force: true });
  }
});

test("file source repository rejects paths and symlink escapes", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink permissions differ on Windows");
    return;
  }
  const ownerDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-source-safe-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-source-out-"));
  const rootDir = path.join(ownerDir, "inputs");
  const repository = new FileSourceRepository({
    rootDir,
    containmentRoot: ownerDir,
  });

  try {
    assert.equal(
      (await repository.save("../escape.txt", Buffer.from("x"), {
        overwrite: false,
      })).status,
      "invalid_path",
    );
    await fs.symlink(outsideDir, rootDir);
    assert.equal(
      (await repository.save("inside.txt", Buffer.from("x"), {
        overwrite: false,
      })).status,
      "invalid_path",
    );
    assert.deepEqual(await repository.list(), []);
  } finally {
    await fs.rm(ownerDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

/**
 * What a refusal looks like once it has crossed out of the parser package.
 *
 * `ParseResult.unsupported` used to be documented as existing "for callers that want to tell 'we
 * will never read this' from 'this parse failed'". No caller could: this repository builds every
 * `FileSourceRecord` the app ever sees, and it maps `error` and nothing else, so the typed field
 * stopped at `_manifest.json`. The documentation now says so, and this is the behaviour the claim
 * was standing in for — the format and the remedy reach the person intact, in `parserError`, which
 * `ui/src/components/shared/file-format.ts` renders beside the upload.
 */
test("a refused format reaches the app as its remedy, and its typed refusal does not", async () => {
  const ownerDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-source-refusal-"));
  const rootDir = path.join(ownerDir, "inputs");
  const repository = new FileSourceRepository({
    rootDir,
    containmentRoot: ownerDir,
  });

  try {
    await repository.save("legacy-report.doc", Buffer.from("OLE2"), {
      overwrite: false,
    });
    const parsedDir = path.join(rootDir, "parsed");
    await fs.mkdir(parsedDir);
    // Exactly the shape `file-parser/parsers/unsupported.ts` writes.
    await fs.writeFile(
      path.join(parsedDir, "_manifest.json"),
      `${JSON.stringify({
        generated_at: "2026-09-13T12:00:00.000Z",
        parser_version: "test",
        files: [
          {
            source: "legacy-report.doc",
            type: "unsupported",
            status: "error",
            outputs: {},
            error:
              "Word 97-2003 (.doc) files cannot be read — open it in Word or LibreOffice, save it as .docx, and upload it again.",
            unsupported: {
              reason: "legacy_binary_office",
              extension: ".doc",
              format: "Word 97-2003 (.doc)",
              remedy:
                "open it in Word or LibreOffice, save it as .docx, and upload it again",
            },
          },
        ],
      })}\n`,
    );

    const [record] = await repository.list();
    assert.ok(record);
    assert.equal(record.parseStatus, "error");
    assert.equal(
      record.parserError,
      "Word 97-2003 (.doc) files cannot be read — open it in Word or LibreOffice, save it as .docx, and upload it again.",
      "the format and the remedy survive the boundary in the one field that crosses it",
    );
    assert.equal(
      "unsupported" in record,
      false,
      "nothing here carries the typed refusal across, so nothing may claim it does",
    );
    assert.equal(record.parsedAt, undefined, "a refusal is not a parse");

    // Still on disk, where diagnosis happens. `FileSourceManifestFile` carries an index
    // signature, so the extra key is read through it rather than asserted into a shape.
    const manifest = await repository.readManifest();
    const refusal = manifest?.files[0]?.["unsupported"];
    assert.ok(
      refusal !== null && typeof refusal === "object" && "reason" in refusal,
    );
    assert.equal(refusal.reason, "legacy_binary_office");
  } finally {
    await fs.rm(ownerDir, { recursive: true, force: true });
  }
});
