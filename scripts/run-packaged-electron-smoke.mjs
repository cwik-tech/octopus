import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function findExecutable() {
  const packageConfig = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const build =
    typeof packageConfig === "object" && packageConfig !== null
      ? Reflect.get(packageConfig, "build")
      : undefined;
  const productName =
    typeof build === "object" && build !== null
      ? Reflect.get(build, "productName")
      : undefined;
  if (
    typeof productName !== "string" ||
    productName.length === 0 ||
    path.basename(productName) !== productName
  ) {
    throw new Error("package.json build.productName must be a safe non-empty name");
  }

  const releasePath = path.join(repositoryRoot, "release");
  const entries = await readdir(releasePath, { withFileTypes: true });
  const preferredDirectories =
    process.arch === "arm64"
      ? ["mac-arm64", "mac-universal", "mac"]
      : ["mac", "mac-universal", "mac-arm64"];
  const availableDirectories = new Set(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );

  for (const directory of preferredDirectories) {
    if (!availableDirectories.has(directory)) continue;
    const executable = path.join(
      releasePath,
      directory,
      `${productName}.app`,
      "Contents",
      "MacOS",
      productName,
    );
    try {
      await access(executable);
      return executable;
    } catch {
      // Continue to the next electron-builder architecture directory.
    }
  }

  throw new Error(
    `Packaged ${productName} executable was not found under ${releasePath}`,
  );
}

const executable = await findExecutable();
const playwright = path.join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "playwright.cmd" : "playwright",
);
const child = spawn(
  playwright,
  [
    "test",
    "-c",
    "playwright.electron.config.ts",
    ...process.argv.slice(2),
  ],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PIPELINE_DESKTOP_EXECUTABLE: executable,
    },
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Packaged Electron smoke exited from signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
