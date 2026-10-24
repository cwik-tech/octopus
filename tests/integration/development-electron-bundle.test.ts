import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  developmentElectronLaunchOptions,
  prepareDevelopmentElectronBundle,
} from "../../services/development/development-electron-bundle.js";

const execFileAsync = promisify(execFile);

test(
  "development Electron bundle exposes Octopus as its macOS display name",
  { skip: process.platform !== "darwin" },
  async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "development-electron-bundle-"),
    );
    const sourceAppPath = path.join(fixtureRoot, "Electron.app");
    const sourceContentsPath = path.join(sourceAppPath, "Contents");
    const sourceExecutablePath = path.join(
      sourceContentsPath,
      "MacOS",
      "Electron",
    );
    const sourcePlistPath = path.join(sourceContentsPath, "Info.plist");

    try {
      await fs.mkdir(path.dirname(sourceExecutablePath), { recursive: true });
      await fs.writeFile(sourceExecutablePath, "fixture executable");
      await fs.writeFile(
        sourcePlistPath,
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
          "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
          '<plist version="1.0">',
          "<dict>",
          "  <key>CFBundleDisplayName</key>",
          "  <string>Electron</string>",
          "</dict>",
          "</plist>",
        ].join("\n"),
      );

      const prepared = await prepareDevelopmentElectronBundle({
        cacheRootPath: path.join(fixtureRoot, "cache"),
        productName: "Octopus",
        sourceAppPath,
      });

      assert.equal(
        prepared.executablePath,
        path.join(prepared.appPath, "Contents", "MacOS", "Electron"),
      );
      assert.equal(path.basename(prepared.appPath), "Octopus.app");
      const { stdout: preparedName } = await execFileAsync(
        "/usr/libexec/PlistBuddy",
        [
          "-c",
          "Print :CFBundleDisplayName",
          path.join(prepared.appPath, "Contents", "Info.plist"),
        ],
      );
      const { stdout: sourceName } = await execFileAsync(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleDisplayName", sourcePlistPath],
      );
      assert.equal(preparedName.trim(), "Octopus");
      assert.equal(sourceName.trim(), "Electron");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  },
);

test(
  "development Electron launch loads the package entry before preparing its macOS bundle",
  { skip: process.platform !== "darwin" },
  async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "development-electron-launch-"),
    );
    const electronPackagePath = path.join(
      fixtureRoot,
      "node_modules",
      "electron",
    );
    const sourceAppPath = path.join(electronPackagePath, "dist", "Electron.app");
    const sourceExecutablePath = path.join(
      sourceAppPath,
      "Contents",
      "MacOS",
      "Electron",
    );
    const sourcePlistPath = path.join(sourceAppPath, "Contents", "Info.plist");
    const loadMarkerPath = path.join(fixtureRoot, "electron-package-loaded");

    try {
      await fs.mkdir(electronPackagePath, { recursive: true });
      await fs.writeFile(
        path.join(fixtureRoot, "package.json"),
        JSON.stringify({ name: "development-electron-launch-fixture" }),
      );
      await fs.writeFile(
        path.join(electronPackagePath, "package.json"),
        JSON.stringify({
          name: "electron",
          version: "43.1.0",
          main: "index.cjs",
        }),
      );
      await fs.writeFile(
        path.join(electronPackagePath, "index.cjs"),
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          `const executablePath = ${JSON.stringify(sourceExecutablePath)};`,
          `const plistPath = ${JSON.stringify(sourcePlistPath)};`,
          `const markerPath = ${JSON.stringify(loadMarkerPath)};`,
          'fs.mkdirSync(path.dirname(executablePath), { recursive: true });',
          'fs.writeFileSync(executablePath, "fixture executable");',
          'fs.writeFileSync(plistPath, [',
          '  "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>",',
          '  "<!DOCTYPE plist PUBLIC \\"-//Apple//DTD PLIST 1.0//EN\\" \\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\\">",',
          '  "<plist version=\\"1.0\\"><dict>",',
          '  "<key>CFBundleDisplayName</key><string>Electron</string>",',
          '  "</dict></plist>",',
          '].join("\\n"));',
          'fs.writeFileSync(markerPath, "loaded");',
          'module.exports = executablePath;',
        ].join("\n"),
      );

      const launch = await developmentElectronLaunchOptions(
        fixtureRoot,
        "darwin",
      );

      assert.equal(await fs.readFile(loadMarkerPath, "utf8"), "loaded");
      assert.equal(launch.electronCliPath, fixtureRoot);
      assert.deepEqual(launch.appArguments, []);
      assert.equal(typeof launch.executablePath, "string");
      if (!launch.executablePath) {
        throw new Error("Development Electron executable was not prepared.");
      }
      await fs.access(launch.executablePath);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  },
);
