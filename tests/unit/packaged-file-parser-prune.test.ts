import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const {
  prunePackagedFileParser,
  resolvePackagedFileParserPath,
}: {
  prunePackagedFileParser: (parserPath: string) => Promise<void>;
  resolvePackagedFileParserPath: (context: {
    appOutDir: string;
    packager: { getResourcesDir: (appOutDir: string) => string };
  }) => string;
} = require(path.resolve("scripts/prune-packaged-file-parser.cjs"));

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

test("desktop packaging enables the production parser prune hook", () => {
  const packageConfig = JSON.parse(
    fs.readFileSync(path.resolve("package.json"), "utf8"),
  ) as {
    build?: {
      afterPack?: string;
      files?: string[];
      extraResources?: Array<{ from?: string; to?: string; filter?: string[] }>;
      mac?: { icon?: string };
    };
    scripts?: { "electron:build"?: string };
  };

  assert.equal(
    packageConfig.build?.afterPack,
    "./scripts/prune-packaged-file-parser.cjs",
  );
  assert.equal(packageConfig.build?.mac?.icon, "build/icon.icns");
  assert.deepEqual(packageConfig.build?.extraResources, [{
    from: "build/youtube-tools",
    to: "youtube-tools",
    filter: ["**/*"],
  }, {
    from: "build/office-tools",
    to: "office-tools",
    filter: ["**/*"],
  }]);
  assert.ok(
    packageConfig.build?.files?.includes("file-parser/THIRD_PARTY_NOTICES.md"),
  );
  assert.match(
    fs.readFileSync(
      path.resolve("file-parser/THIRD_PARTY_NOTICES.md"),
      "utf8",
    ),
    /MIT License[\s\S]*Copyright \(c\) 2026 Firecrawl/,
  );
  assert.ok(fs.statSync(path.resolve("build/icon.icns")).size > 0);
  assert.match(
    packageConfig.scripts?.["electron:build"] ?? "",
    /clean-electron-build\.mjs/,
  );
});

test("CI verifies the native PDF parser on every declared runtime platform", () => {
  const workflow = fs.readFileSync(
    path.resolve(".github/workflows/ci.yml"),
    "utf8",
  );

  assert.match(workflow, /file-parser-native:/);
  assert.match(workflow, /os: \[ubuntu-latest, macos-14, windows-latest\]/);
  assert.match(workflow, /npm --prefix file-parser run native:smoke/);
});

test("packaged parser path stays inside electron-builder resources", () => {
  const appOutDir = path.join(os.tmpdir(), "pipeline-package-output");
  const resourcesPath = path.join(appOutDir, "Pipeline.app", "Resources");

  assert.equal(
    resolvePackagedFileParserPath({
      appOutDir,
      packager: { getResourcesDir: () => resourcesPath },
    }),
    path.join(resourcesPath, "app", "file-parser"),
  );
});

test("packaged parser prune removes development modules and keeps runtime modules", async () => {
  const parserPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "packaged-parser-prune-"),
  );
  const nodeModulesPath = path.join(parserPath, "node_modules");
  const runtimePath = path.join(nodeModulesPath, "runtime-only");
  const developmentPath = path.join(nodeModulesPath, "development-only");
  fs.mkdirSync(runtimePath, { recursive: true });
  fs.mkdirSync(developmentPath, { recursive: true });

  writeJson(path.join(parserPath, "package.json"), {
    name: "packaged-parser-fixture",
    version: "1.0.0",
    dependencies: { "runtime-only": "1.0.0" },
    devDependencies: { "development-only": "1.0.0" },
  });
  writeJson(path.join(runtimePath, "package.json"), {
    name: "runtime-only",
    version: "1.0.0",
  });
  writeJson(path.join(developmentPath, "package.json"), {
    name: "development-only",
    version: "1.0.0",
  });
  writeJson(path.join(nodeModulesPath, ".package-lock.json"), {
    name: "packaged-parser-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "packaged-parser-fixture",
        version: "1.0.0",
        dependencies: { "runtime-only": "1.0.0" },
        devDependencies: { "development-only": "1.0.0" },
      },
      "node_modules/runtime-only": { version: "1.0.0" },
      "node_modules/development-only": { version: "1.0.0", dev: true },
    },
  });

  try {
    await prunePackagedFileParser(parserPath);
    assert.equal(fs.existsSync(runtimePath), true);
    assert.equal(fs.existsSync(developmentPath), false);
  } finally {
    fs.rmSync(parserPath, { recursive: true, force: true });
  }
});

test("the packaged parser keeps every OCR asset after the production prune", async () => {
  const parserRoot = path.resolve("file-parser");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(parserRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  // Declared, and pinned: production OCR must not depend on a transitive package remaining
  // installed, and a floating range would let the recognition settings change under a contract
  // that says they did not.
  assert.equal(manifest.dependencies?.["tesseract.js"], "7.0.0");
  assert.equal(manifest.dependencies?.["@tesseract.js-data/eng"], "1.0.0");
  assert.equal(manifest.dependencies?.["pdfjs-dist"], "5.4.624");
  assert.equal(manifest.devDependencies?.["tesseract.js"], undefined);
  assert.equal(manifest.devDependencies?.["@tesseract.js-data/eng"], undefined);
  assert.equal(manifest.devDependencies?.["pdfjs-dist"], undefined);

  // The production tree is what `npm prune --omit=dev` keeps.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ls", "--omit=dev", "--all", "--parseable"],
    { cwd: parserRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const productionPackages = new Set(
    stdout
      .split("\n")
      .filter(Boolean)
      .map((entry) => path.relative(parserRoot, entry)),
  );
  for (const packagePath of [
    path.join("node_modules", "tesseract.js"),
    path.join("node_modules", "tesseract.js-core"),
    path.join("node_modules", "@tesseract.js-data", "eng"),
    path.join("node_modules", "pdfjs-dist"),
    path.join("node_modules", "@napi-rs", "canvas"),
  ]) {
    assert.ok(
      productionPackages.has(packagePath),
      `${packagePath} must survive the production prune`,
    );
  }

  // The renderer entry recognition imports, its worker, and the font/cmap data it opens.
  const pdfjsRoot = path.join(parserRoot, "node_modules", "pdfjs-dist");
  assert.ok(
    fs.statSync(path.join(pdfjsRoot, "legacy", "build", "pdf.mjs")).size > 0,
    "the pdfjs-dist legacy build entry is packaged",
  );
  assert.ok(
    fs.statSync(path.join(pdfjsRoot, "legacy", "build", "pdf.worker.mjs")).size > 0,
    "the pdfjs-dist worker is packaged",
  );
  assert.ok(
    fs.readdirSync(path.join(pdfjsRoot, "standard_fonts")).length > 0,
    "the pdfjs-dist standard fonts are packaged",
  );
  assert.ok(
    fs.readdirSync(path.join(pdfjsRoot, "cmaps")).length > 0,
    "the pdfjs-dist cmaps are packaged",
  );
  // Rendering in Node draws through @napi-rs/canvas, an optional pdfjs-dist dependency: the
  // packaged app cannot render a page without it.
  const napiCanvas = path.join(parserRoot, "node_modules", "@napi-rs", "canvas");
  assert.ok(
    fs.statSync(path.join(napiCanvas, "index.js")).size > 0,
    "the @napi-rs/canvas binding is packaged",
  );

  // The three logical assets recognition actually opens.
  const workerScript = path.join(
    parserRoot, "node_modules", "tesseract.js", "src", "worker-script", "node", "index.js",
  );
  const trainedData = path.join(
    parserRoot, "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz",
  );
  assert.ok(fs.statSync(workerScript).size > 0, "the worker script is packaged");
  assert.ok(fs.statSync(trainedData).size > 0, "the selected English trained data is packaged");
  const coreDir = path.join(parserRoot, "node_modules", "tesseract.js-core");
  const wasmVariants = fs
    .readdirSync(coreDir)
    .filter((entry) => entry.endsWith(".wasm"));
  // `getCore` selects a variant at runtime from CPU feature detection, so every variant it can
  // choose has to be present; a packaged app that shipped only one would fail on some machines.
  assert.ok(
    ["tesseract-core-lstm.wasm", "tesseract-core-simd-lstm.wasm", "tesseract-core-relaxedsimd-lstm.wasm"]
      .every((variant) => wasmVariants.includes(variant)),
    `the LSTM WebAssembly variants are packaged, found: ${wasmVariants.join(", ")}`,
  );

  // The packaged app ships file-parser's node_modules, which is what carries all of the above.
  const packageConfig = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
    build?: { files?: string[] };
  };
  assert.ok(packageConfig.build?.files?.includes("file-parser/node_modules/**/*"));
});

test("shipped OCR licences are recorded in the parser notices", () => {
  const notices = fs.readFileSync(
    path.resolve("file-parser/THIRD_PARTY_NOTICES.md"),
    "utf8",
  );

  assert.match(notices, /Tesseract\.js/);
  assert.match(notices, /tesseract\.js-core/);
  assert.match(notices, /@tesseract\.js-data\/eng/);
  assert.match(notices, /pdfjs-dist/);
  assert.match(notices, /Apache License/);
});
