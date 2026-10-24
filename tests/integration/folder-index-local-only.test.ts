/**
 * LF-13: parsing a document from a shared folder never sends it to an outside model.
 *
 * The parent process is set up the way an app with enrichment switched on would be: every
 * variable that turns enrichment on, picks its provider and model, carries an API key, and names
 * the endpoint, with that endpoint a real loopback sentinel that counts every request reaching
 * it. The launcher is the source launcher wrapped by the coordinator, as the API server wires it,
 * and it runs the real parser process on a document the parser would otherwise enrich.
 *
 * The second test is the control: the same document and the same parent environment do reach the
 * sentinel when the parse is not local-only, so a zero count in the first test means the run was
 * kept local, not that enrichment could never have happened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import { coordinateFileParserLauncher } from "../../core/file-parse-coordinator.js";
import { SourceFileParserLauncher } from "../../core/file-parser-launcher.js";
import { MIXED_OCR_FIXTURE } from "../../file-parser/tests/mixed-ocr-expectations.js";

const manifestSchema = z.object({
  files: z.array(
    z.object({
      source: z.string(),
      status: z.string(),
      outputs: z.record(z.string(), z.string()),
      metadata: z.record(z.string(), z.unknown()),
    }),
  ),
});

interface Sentinel {
  readonly baseUrl: string;
  requestCount(): number;
  close(): Promise<void>;
}

/** A loopback endpoint that answers nothing useful and counts everything that reaches it. */
async function startSentinel(): Promise<Sentinel> {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("enrichment sentinel");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The sentinel did not get a loopback port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function enrichmentSwitchedOn(baseUrl: string): Record<string, string> {
  return {
    FILE_PARSER_LLM_ENABLED: "1",
    FILE_PARSER_LM_ENABLED: "1",
    FILE_PARSER_LLM_PROVIDER: "openai",
    FILE_PARSER_LM_PROVIDER: "openai",
    FILE_PARSER_LLM_MODEL: "sentinel-model",
    FILE_PARSER_LM_MODEL: "sentinel-model",
    FILE_PARSER_OPENAI_API_KEY: "sentinel-parser-key",
    OPENAI_API_KEY: "sentinel-openai-key",
    FILE_PARSER_OPENAI_BASE_URL: baseUrl,
  };
}

/** Sets variables on this process, the parser's parent, for the duration of `run`. */
async function withParentEnvironment<T>(
  values: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface SharedFolderDocument {
  readonly root: string;
  readonly filePath: string;
  readonly outputDir: string;
}

/** A document inside a user's folder, and an output folder of the app's own, outside it. */
function makeSharedFolderDocument(): SharedFolderDocument {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "folder-index-local-only-"));
  const folder = path.join(root, "shared", "Board packs");
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, MIXED_OCR_FIXTURE.fileName);
  fs.copyFileSync(
    path.join(process.cwd(), "file-parser", "tests", "fixtures", MIXED_OCR_FIXTURE.fileName),
    filePath,
  );
  return {
    root,
    filePath,
    outputDir: path.join(root, "app-cache", "folder-index", "files", "document-1"),
  };
}

function readManifest(outputDir: string): z.infer<typeof manifestSchema> {
  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(outputDir, "_manifest.json"), "utf8"),
  );
  return manifestSchema.parse(raw);
}

function folderIndexLauncher() {
  return coordinateFileParserLauncher(new SourceFileParserLauncher(process.cwd()));
}

test("a local-only parse sends nothing to the enrichment endpoint the parent environment names, and still reads pixel-only text", async () => {
  const sentinel = await startSentinel();
  const document = makeSharedFolderDocument();
  try {
    await withParentEnvironment(enrichmentSwitchedOn(sentinel.baseUrl), () =>
      folderIndexLauncher().parseFile({
        filePath: document.filePath,
        outputDir: document.outputDir,
        localOnly: true,
      }),
    );

    assert.equal(sentinel.requestCount(), 0, "No request reached the enrichment endpoint");

    const manifest = readManifest(document.outputDir);
    assert.equal(manifest.files.length, 1);
    const entry = manifest.files[0];
    assert.ok(entry);
    assert.equal(entry.source, MIXED_OCR_FIXTURE.fileName);
    assert.equal(entry.status, "success");
    assert.equal(entry.outputs.enriched, undefined, "No enriched output was written");
    assert.equal(
      entry.metadata.enrichment_error,
      undefined,
      "Enrichment was never attempted, against any endpoint",
    );
    const textOutput = entry.outputs.text;
    assert.ok(textOutput, "The parse wrote its text output");
    const text = fs.readFileSync(path.join(document.outputDir, textOutput), "utf8");
    assert.ok(
      text.includes(MIXED_OCR_FIXTURE.page10.title),
      "Local OCR still read the page that exists only as pixels",
    );
  } finally {
    await sentinel.close();
    fs.rmSync(document.root, { recursive: true, force: true });
  }
});

test("the same document and parent environment reach the sentinel when the parse is not local-only", async () => {
  const sentinel = await startSentinel();
  const document = makeSharedFolderDocument();
  try {
    await withParentEnvironment(enrichmentSwitchedOn(sentinel.baseUrl), () =>
      folderIndexLauncher().parseFile({
        filePath: document.filePath,
        outputDir: document.outputDir,
        localOnly: false,
      }),
    );

    assert.ok(
      sentinel.requestCount() > 0,
      "Without local-only, this document and environment request enrichment",
    );
  } finally {
    await sentinel.close();
    fs.rmSync(document.root, { recursive: true, force: true });
  }
});
