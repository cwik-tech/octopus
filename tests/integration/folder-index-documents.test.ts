/**
 * Documents in attached folders, parsed by the real file parser into the app's
 * cache (docs/feature-local-folder-access.md, "Indexing and the parse cache";
 * LF-06, LF-14, and the restart, retention and output budget rules).
 *
 * The launcher is the source launcher wrapped by the coordinator, as the API
 * server wires it, and each parse runs the real parser process. A recording
 * wrapper only counts the parses it passes through. Every folder is a real
 * temporary folder, and the cache lives in a real temporary workspace beside it.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import JSZip from "jszip";

import { coordinateFileParserLauncher } from "../../core/file-parse-coordinator.js";
import {
  SourceFileParserLauncher,
  type FileParseRequest,
  type FileParserLauncher,
  type FileParserRequestOptions,
} from "../../core/file-parser-launcher.js";
import { searchFolder, walkFolder, type FolderAccessContext } from "../../domains/shared-folders/folder-access.js";
import { folderIndexDocuments } from "../../domains/shared-folders/folder-documents.js";
import {
  FolderIndex,
  type FolderDocument,
  type FolderIndexOptions,
} from "../../domains/shared-folders/folder-index.js";

const FIXTURES = path.join(process.cwd(), "file-parser", "tests", "fixtures");

/** The real launcher, with every request it passes on written down. */
class RecordingLauncher implements FileParserLauncher {
  readonly requests: FileParseRequest[] = [];
  private readonly inner = coordinateFileParserLauncher(new SourceFileParserLauncher(process.cwd()));

  parseDirectory(inputDir: string, options?: FileParserRequestOptions): Promise<void> {
    return this.inner.parseDirectory(inputDir, options);
  }

  parseFile(request: FileParseRequest, options?: FileParserRequestOptions): Promise<void> {
    this.requests.push(request);
    return this.inner.parseFile(request, options);
  }
}

interface Setup {
  readonly root: string;
  readonly workspace: string;
}

function makeSetup(t: TestContext): Setup {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folder-index-documents-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "Shared");
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(root);
  fs.mkdirSync(workspace);
  return { root, workspace };
}

function makeIndex(
  setup: Setup,
  launcher: FileParserLauncher,
  options: Partial<FolderIndexOptions> = {},
): FolderIndex {
  return new FolderIndex({
    workspacePath: setup.workspace,
    launcher,
    isRetained: async () => true,
    // A read waits for its parse however long the parser takes on this machine.
    waitLimit: () => new Promise<void>(() => undefined),
    ...options,
  });
}

/** Copy a parser fixture into the folder and measure it as a folder scan would. */
function copyFixture(root: string, relativePath: string, fixture: string): FolderDocument {
  const file = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), file);
  const stat = fs.statSync(file);
  return { path: relativePath, size: stat.size, mtimeMs: stat.mtime.getTime() };
}

/**
 * Every entry under `root`, with its size and modification time. A directory's
 * modification time changes when anything is created in it, even briefly, so
 * equal snapshots mean nothing was written there at all.
 */
function snapshotTree(root: string): string[] {
  const rows = [`.|dir|${fs.statSync(root).mtimeMs}`];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const fullPath = path.join(entry.parentPath, entry.name);
    const stat = fs.lstatSync(fullPath);
    rows.push(`${path.relative(root, fullPath)}|${stat.isDirectory() ? "dir" : String(stat.size)}|${stat.mtimeMs}`);
  }
  return rows.sort();
}

/** The folders under the workspace's folder index, one per indexed folder. */
function cachedFolders(workspace: string): string[] {
  const indexRoot = path.join(workspace, "folder-index");
  return fs.existsSync(indexRoot) ? fs.readdirSync(indexRoot).map((name) => path.join(indexRoot, name)) : [];
}

function textOf(result: Awaited<ReturnType<FolderIndex["readDocument"]>>): string {
  assert.ok(result.ok, `Expected text, got ${result.ok ? "" : `${result.code}: ${result.message}`}`);
  return result.text;
}

test("text inside a PDF in an attached folder becomes readable from the cache, and the folder gains no files", async (t) => {
  const setup = makeSetup(t);
  const index = makeIndex(setup, new RecordingLauncher());
  const plan = copyFixture(setup.root, "Board packs/business plan.pdf", "malformed-trailer.pdf");
  const before = snapshotTree(setup.root);

  await index.reconcile(setup.root, { documents: [plan], complete: true });
  const text = textOf(await index.readDocument(setup.root, plan));
  await index.whenIdle();

  assert.match(text, /soil water retention technology/);
  assert.deepEqual(snapshotTree(setup.root), before, "Nothing was written inside the user's folder");
});

test("two documents with the same name in different subfolders each read as their own text", async (t) => {
  const setup = makeSetup(t);
  const index = makeIndex(setup, new RecordingLauncher());
  const acme = copyFixture(setup.root, "Clients/Acme/contract.docx", "docx-table.docx");
  const globex = copyFixture(setup.root, "Clients/Globex/contract.docx", "business-plan.docx");

  await index.reconcile(setup.root, { documents: [acme, globex], complete: true });
  await Promise.all([index.readDocument(setup.root, acme), index.readDocument(setup.root, globex)]);
  await index.whenIdle();
  const acmeText = textOf(await index.readCached(setup.root, acme));
  const globexText = textOf(await index.readCached(setup.root, globex));

  assert.ok(acmeText.includes("| Growth | 12.5% |"));
  assert.ok(!acmeText.includes("ExampleCo"));
  assert.ok(globexText.includes("ExampleCo"));
  assert.ok(!globexText.includes("12.5%"));
});

test("after a restart, unfinished parses are deleted and a document whose output is missing is parsed again", async (t) => {
  const setup = makeSetup(t);
  const notes = copyFixture(setup.root, "notes/field-notes.odt", "field-notes.odt");
  const minutes = copyFixture(setup.root, "notes/minutes.rtf", "meeting-minutes.rtf");
  const before = makeIndex(setup, new RecordingLauncher());
  await before.reconcile(setup.root, { documents: [notes, minutes], complete: true });
  textOf(await before.readDocument(setup.root, notes));
  textOf(await before.readDocument(setup.root, minutes));
  await before.whenIdle();

  // What a crash leaves: a parse that never published, and an output lost from the cache.
  const [folderCache] = cachedFolders(setup.workspace);
  assert.ok(folderCache);
  const unfinished = path.join(folderCache, "tmp", "unfinished", "output");
  fs.mkdirSync(unfinished, { recursive: true });
  fs.writeFileSync(path.join(unfinished, "minutes.rtf.md"), "half-written");
  const lostOutput = fs.readdirSync(folderCache, { recursive: true, withFileTypes: true })
    .find((entry) => entry.isFile() && entry.name === "minutes.rtf.md" && !entry.parentPath.startsWith(path.join(folderCache, "tmp")));
  assert.ok(lostOutput);
  fs.rmSync(lostOutput.parentPath, { recursive: true });

  const launcher = new RecordingLauncher();
  const after = makeIndex(setup, launcher);
  await after.startup();

  assert.equal(fs.existsSync(path.join(folderCache, "tmp")), false, "Unfinished parses are deleted");
  assert.equal((await after.status(setup.root)).pendingDocuments, 1);
  assert.match(textOf(await after.readCached(setup.root, notes)), /Membrane Rollout Notes/);
  assert.match(textOf(await after.readDocument(setup.root, minutes)), /Quarterly Operations Minutes/);
  await after.whenIdle();
  assert.deepEqual(launcher.requests.map((request) => path.basename(request.filePath)), ["minutes.rtf"]);
});

test("at startup, the cache of a folder that lost its grant or its last attachment is deleted", async (t) => {
  const setup = makeSetup(t);
  const notes = copyFixture(setup.root, "field-notes.odt", "field-notes.odt");
  const before = makeIndex(setup, new RecordingLauncher());
  textOf(await before.readDocument(setup.root, notes));
  await before.whenIdle();
  assert.equal(cachedFolders(setup.workspace).length, 1);

  const after = makeIndex(setup, new RecordingLauncher(), { isRetained: async () => false });
  await after.startup();

  assert.deepEqual(cachedFolders(setup.workspace), []);
});

test("once a folder's parsed output would pass its budget, parsing stops and the folder says which limit it hit", async (t) => {
  const setup = makeSetup(t);
  const launcher = new RecordingLauncher();
  const index = makeIndex(setup, launcher, { limits: { maxOutputBytesPerFolder: 100 } });
  const first = copyFixture(setup.root, "a/contract.docx", "docx-table.docx");
  const second = copyFixture(setup.root, "b/notes.odt", "field-notes.odt");

  const refused = await index.readDocument(setup.root, first);
  await index.reconcile(setup.root, { documents: [first, second], complete: true });
  const alsoRefused = await index.readDocument(setup.root, second);
  await index.whenIdle();

  assert.equal(!refused.ok && refused.code, "over_budget");
  assert.equal(!alsoRefused.ok && alsoRefused.code, "over_budget");
  assert.equal(launcher.requests.length, 1, "Nothing more is parsed once the budget is reached");
  assert.match((await index.status(setup.root)).limit ?? "", /100 bytes of parsed text/);
  assert.equal(fs.readdirSync(cachedFolders(setup.workspace)[0] ?? "", { recursive: true })
    .some((name) => String(name).startsWith("files")), false, "No output was kept");
});

/** A one-slide PowerPoint file; the parser's fixtures hold no .pptx. */
async function writeSlideDeck(file: string, text: string): Promise<void> {
  const zip = new JSZip();
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const relationships = (rows: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows}</Relationships>`;
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');
  zip.file("_rels/.rels", relationships('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'));
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", relationships('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'));
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8"?><p:sld ${ns}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

test("search finds text inside every document type an attached folder can hold", async (t) => {
  const setup = makeSetup(t);
  const index = makeIndex(setup, new RecordingLauncher());
  const documents = folderIndexDocuments(index);
  const context: FolderAccessContext = { root: setup.root, isProtected: async () => false, documents };
  const expected: Array<readonly [query: string, document: string]> = [
    ["soil water retention technology", "Docs/plan.pdf"],
    ["exampleco", "Docs/business-plan.docx"],
    ["farm alpha", "Docs/financials.xlsx"],
    ["orchard pilot", "Docs/kickoff.pptx"],
    ["membrane rollout notes", "Docs/field-notes.odt"],
    ["soybeans", "Docs/yield-data.ods"],
    ["harvest delays fell", "Docs/pilot-review.odp"],
    ["quarterly operations minutes", "Docs/minutes.rtf"],
  ];
  copyFixture(setup.root, "Docs/plan.pdf", "malformed-trailer.pdf");
  copyFixture(setup.root, "Docs/business-plan.docx", "business-plan.docx");
  copyFixture(setup.root, "Docs/financials.xlsx", "financials.xlsx");
  await writeSlideDeck(path.join(setup.root, "Docs", "kickoff.pptx"), "Kickoff agenda for the orchard pilot");
  copyFixture(setup.root, "Docs/field-notes.odt", "field-notes.odt");
  copyFixture(setup.root, "Docs/yield-data.ods", "yield-data.ods");
  copyFixture(setup.root, "Docs/pilot-review.odp", "pilot-review.odp");
  copyFixture(setup.root, "Docs/minutes.rtf", "meeting-minutes.rtf");
  // What a turn's folder map does: walk the folder and hand it to the index, which parses in the background.
  const walk = await walkFolder(context);
  assert.ok(walk.ok);
  await documents.refresh(setup.root, walk);
  await index.whenIdle();

  const found: Array<readonly [string, string]> = [];
  for (const [query, document] of expected) {
    const result = await searchFolder(context, query);
    assert.ok(result.ok, query);
    const hit = result.hits.find((candidate) => candidate.path === document && candidate.line > 0);
    found.push([query, hit ? document : `no text hit among ${JSON.stringify(result.hits)}`]);
  }

  assert.deepEqual(found, expected);
});
