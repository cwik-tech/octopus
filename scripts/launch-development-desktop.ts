import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import * as path from "node:path";

import { launchDevelopmentDesktop } from "../services/development/development-desktop-launcher.js";
import { developmentElectronLaunchOptions } from "../services/development/development-electron-bundle.js";

const HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const trackedChildren = new Set<ChildProcess>();
  let receivedSignal: NodeJS.Signals | undefined;
  const track = (child: ChildProcess): ChildProcess => {
    trackedChildren.add(child);
    child.once("exit", () => trackedChildren.delete(child));
    return child;
  };
  const forwardSignal = (signal: NodeJS.Signals) => {
    receivedSignal = signal;
    for (const child of trackedChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
  };
  const sigint = () => forwardSignal("SIGINT");
  const sigterm = () => forwardSignal("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  const rendererPort = await availableLoopbackPort();
  const rendererUrl = `http://${HOST}:${rendererPort}`;
  const vite = track(spawn(npmExecutable(), [
    "--prefix",
    "ui",
    "run",
    "dev",
    "--",
    "--host",
    HOST,
    "--port",
    String(rendererPort),
    "--strictPort",
  ], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  }));

  try {
    const build = track(spawn(npmExecutable(), ["run", "electron:build"], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    }));
    const [buildResult] = await Promise.all([
      waitForProcess(build),
      waitForLoopbackServer(vite, rendererPort, STARTUP_TIMEOUT_MS),
    ]);
    if (buildResult.signal || buildResult.code !== 0) {
      throw new Error(
        `Electron development build failed with ${formatExit(buildResult)}.`,
      );
    }

    const electronLaunch = await developmentElectronLaunchOptions(repositoryRoot);
    const desktopOutcome = launchDevelopmentDesktop({
      ...electronLaunch,
      environment: {
        ...process.env,
        VITE_DEV_SERVER_URL: rendererUrl,
      },
      onChildSpawn: track,
      onReplacementWait: ({ attempts }) => {
        if (attempts === 1) {
          console.log(
            "The existing development desktop is shutting down gracefully. Waiting to start the rebuilt instance...",
          );
        }
      },
      replaceExisting: true,
      repositoryRoot,
    }).then((result) => ({ kind: "desktop" as const, result }));
    const viteOutcome = waitForProcess(vite).then((result) => ({
      kind: "vite" as const,
      result,
    }));
    const outcome = await Promise.race([desktopOutcome, viteOutcome]);
    if (outcome.kind === "vite") {
      for (const child of trackedChildren) {
        if (
          child !== vite &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          child.kill("SIGTERM");
        }
      }
      await desktopOutcome.catch(() => undefined);
      if (receivedSignal) return;
      throw new Error(
        `Vite exited unexpectedly with ${formatExit(outcome.result)}.`,
      );
    }
    const result = outcome.result;
    if (!receivedSignal) {
      process.exitCode = result.signal ? 1 : result.code ?? 1;
    }
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    const remainingChildren = [...trackedChildren];
    for (const child of remainingChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }
    await Promise.allSettled(remainingChildren.map(waitForProcess));
    if (receivedSignal) {
      process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
    }
  }
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback port for Vite.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForLoopbackServer(
  process: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<void> {
  let spawnError: Error | undefined;
  const recordSpawnError = (error: Error) => {
    spawnError = error;
  };
  process.once("error", recordSpawnError);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (process.exitCode !== null || process.signalCode !== null) {
        throw new Error(
          `Vite exited before becoming ready with ${formatExit({
            code: process.exitCode,
            signal: process.signalCode,
          })}.`,
        );
      }
      if (await canConnect(port)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Vite did not listen on ${HOST}:${port} within ${timeoutMs}ms.`,
    );
  } finally {
    process.off("error", recordSpawnError);
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function waitForProcess(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function formatExit(result: {
  code: number | null;
  signal: NodeJS.Signals | null;
}): string {
  return result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
