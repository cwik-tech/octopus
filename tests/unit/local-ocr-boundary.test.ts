/**
 * Where OCR is allowed to live, and where every PDF upload has to go.
 *
 * Two properties this repository has to keep as it grows:
 *
 * - **One OCR implementation.** Recognition, rasterization for recognition, word geometry and
 *   page selection live in `file-parser/ocr/`. A second one added anywhere else is how two
 *   upload routes start disagreeing about what a document says.
 * - **One parsing entry.** Every visible upload and every non-UI ingestion path reaches
 *   `FileParserLauncher`, which is what makes local OCR reach all of them at once.
 *
 * Both are checked by reading the production sources, because both are properties of the code's
 * shape rather than of any one run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

// The working directory, not a path relative to this file: the suite compiles to
// `.tests-dist/` and runs from there, where a relative walk would land inside the build output.
const REPO_ROOT = path.resolve(".");

const PRODUCTION_ROOTS = [
  "contracts",
  "core",
  "domains",
  "electron",
  "engines",
  "file-parser",
  "parsers",
  "providers",
  "server",
  "services",
  "shared",
  "team-runtime",
  "ui/src",
] as const;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "__tests__",
  "tests",
  "fixtures",
]);

const OCR_ENGINE_PACKAGES = ["tesseract.js", "@tesseract.js-data/eng"] as const;

/** The one folder that owns OCR, relative to the repository root. */
const OCR_FOLDER = path.join("file-parser", "ocr");

function listProductionFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(path.join(directory, entry.name));
        continue;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx|mts|cts)$/.test(entry.name)) continue;
      files.push(path.join(directory, entry.name));
    }
  };
  for (const root of PRODUCTION_ROOTS) {
    const absolute = path.join(REPO_ROOT, root);
    if (fs.existsSync(absolute)) walk(absolute);
  }
  return files;
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file);
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

test("the OCR engine and its language data are imported only from file-parser/ocr", () => {
  const offenders: string[] = [];
  for (const file of listProductionFiles()) {
    const location = relative(file);
    if (location.startsWith(`${OCR_FOLDER}${path.sep}`)) continue;
    const source = read(file);
    for (const packageName of OCR_ENGINE_PACKAGES) {
      if (new RegExp(`from ['"]${packageName.replace(".", "\\.")}['"]|import\\(['"]${packageName.replace(".", "\\.")}`).test(source)) {
        offenders.push(`${location} imports ${packageName}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "OCR engine code belongs in file-parser/ocr only");
});

test("only the PDF parser reaches the OCR module's production entry", () => {
  const importers: string[] = [];
  for (const file of listProductionFiles()) {
    const location = relative(file);
    if (location.startsWith(`${OCR_FOLDER}${path.sep}`)) continue;
    if (/from ['"][^'"]*\/ocr\/read-pages\.js['"]/.test(read(file))) {
      importers.push(location);
    }
  }
  assert.deepEqual(
    importers,
    [path.join("file-parser", "parsers", "pdf.ts")],
    "read-pages.ts is the only production entry, and the PDF parser is its only caller",
  );
});

test("nothing outside file-parser reaches into the OCR folder beyond its published contract", () => {
  // `contract.ts` is the module's published seam: the versioned summary shape and its fail-closed
  // validator, with no engine and no rasterizer. Consumers of a stored manifest (for example the
  // team-file reader gate) import that one module so the contract has a single spelling. Every
  // other module in the folder is the one OCR implementation itself and stays file-parser-only.
  const offenders: string[] = [];
  for (const file of listProductionFiles()) {
    const location = relative(file);
    if (location.startsWith(`file-parser${path.sep}`)) continue;
    for (const match of read(file).matchAll(/from ['"][^'"]*file-parser\/ocr\/([a-z-]+)\.js['"]/g)) {
      if (match[1] !== "contract") offenders.push(`${location} imports file-parser/ocr/${match[1]}.js`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("every visible upload endpoint parses through the shared file-parser launcher", () => {
  // Run session uploads, Create Agent and Team uploads, and Library project uploads. The
  // Workflow Architect chat has no upload control; adding one must reuse this same launcher.
  const routes = [
    path.join("server", "routes", "sessions.ts"),
    path.join("server", "routes", "team-files.ts"),
    path.join("server", "routes", "projects.ts"),
  ];
  for (const route of routes) {
    const source = read(path.join(REPO_ROOT, route));
    assert.match(
      source,
      /fileParserLauncher(?:!)?\.parseDirectory\(/,
      `${route} must invoke FileParserLauncher before reporting an upload as parsed`,
    );
    for (const packageName of OCR_ENGINE_PACKAGES) {
      assert.ok(!source.includes(packageName), `${route} must not own OCR`);
    }
  }
});

test("the Workflow Architect chat still exposes no upload control", () => {
  // Stated as a fact this repository keeps true, because the upload topology above depends on
  // it: a composer added here would be a fourth upload path.
  const panel = read(
    path.join(REPO_ROOT, "ui", "src", "components", "create", "workflow-architect-panel.tsx"),
  );
  assert.ok(
    !/fileComposer/.test(panel),
    "Workflow Architect has no upload today; adding one must reuse the shared parser route",
  );
});

test("non-UI ingestion delegates to the shared launcher and owns no recognition code", () => {
  const consumers = [
    path.join("services", "mcp-resource-import-service.ts"),
    path.join("services", "batch-admission-coordinator.ts"),
    path.join("domains", "acquisition", "native-document-parser.ts"),
    path.join("domains", "browser", "browser-manager.ts"),
  ];
  for (const consumer of consumers) {
    const source = read(path.join(REPO_ROOT, consumer));
    assert.match(
      source,
      /\.parseDirectory\(/,
      `${consumer} must ingest through FileParserLauncher`,
    );
    for (const packageName of OCR_ENGINE_PACKAGES) {
      assert.ok(
        !source.includes(packageName),
        `${consumer} must inherit OCR from the parser, not implement it`,
      );
    }
    assert.ok(
      !/file-parser\/ocr\//.test(source),
      `${consumer} must not reach into the OCR module`,
    );
  }
});
