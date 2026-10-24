import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const coordinatorUrl = pathToFileURL(
  path.resolve("core", "file-parse-coordinator.ts"),
).href;

test("independent processes serialize parser work for one input directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-parse-processes-"));
  const inputDir = path.join(root, "inputs");
  const eventsPath = path.join(root, "events.jsonl");
  await fs.mkdir(inputDir);
  const script = `
    import fs from "node:fs/promises";
    import { coordinateFileParserLauncher } from ${JSON.stringify(coordinatorUrl)};
    const inputDir = process.env.TEST_INPUT_DIR;
    const eventsPath = process.env.TEST_EVENTS_PATH;
    if (!inputDir || !eventsPath) throw new Error("Missing test paths");
    const launcher = coordinateFileParserLauncher({
      async parseDirectory() {
        await fs.appendFile(eventsPath, JSON.stringify({ type: "start", pid: process.pid }) + "\\n");
        await new Promise((resolve) => setTimeout(resolve, 150));
        await fs.appendFile(eventsPath, JSON.stringify({ type: "end", pid: process.pid }) + "\\n");
      },
    }, { lockTimeoutMs: 5_000 });
    await launcher.parseDirectory(inputDir);
  `;

  try {
    await Promise.all([
      runCoordinatorProcess(script, inputDir, eventsPath),
      runCoordinatorProcess(script, inputDir, eventsPath),
    ]);
    const events = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; pid: number });

    assert.deepEqual(events.map((event) => event.type), [
      "start",
      "end",
      "start",
      "end",
    ]);
    assert.equal(events[0]?.pid, events[1]?.pid);
    assert.equal(events[2]?.pid, events[3]?.pid);
    assert.notEqual(events[0]?.pid, events[2]?.pid);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function runCoordinatorProcess(
  script: string,
  inputDir: string,
  eventsPath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_INPUT_DIR: inputDir,
          TEST_EVENTS_PATH: eventsPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Coordinator child failed (${signal ?? code ?? "unknown"}): ${stderr}`,
        ),
      );
    });
  });
}
