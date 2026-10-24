import { launchDevelopmentDesktop } from "../services/development/development-desktop-launcher.js";
import { developmentElectronLaunchOptions } from "../services/development/development-electron-bundle.js";
import { whenDefined } from "../core/optional-properties.js";

interface LaunchArguments {
  replaceExisting: boolean;
  viteDevServerUrl?: string;
}

async function main(): Promise<void> {
  const launchArguments = parseArguments(process.argv.slice(2));
  const repositoryRoot = process.cwd();
  const environment = { ...process.env };
  if (launchArguments.viteDevServerUrl) {
    environment.VITE_DEV_SERVER_URL = launchArguments.viteDevServerUrl;
  }
  const electronLaunch = await developmentElectronLaunchOptions(repositoryRoot);

  const result = await launchDevelopmentDesktop({
    ...electronLaunch,
    environment,
    forwardSignals: true,
    onReplacementWait: ({ attempts }) => {
      if (attempts === 1) {
        console.log(
          "The existing development desktop is shutting down gracefully. Waiting to start the rebuilt instance...",
        );
      }
    },
    replaceExisting: launchArguments.replaceExisting,
    repositoryRoot,
  });

  if (result.signal) {
    if (process.platform === "win32") {
      process.exitCode = 1;
      return;
    }
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

function parseArguments(values: readonly string[]): LaunchArguments {
  let replaceExisting = false;
  let viteDevServerUrl: string | undefined;

  for (const value of values) {
    if (value === "--replace-existing") {
      replaceExisting = true;
      continue;
    }
    if (value.startsWith("--vite-dev-server-url=")) {
      viteDevServerUrl = value.slice("--vite-dev-server-url=".length);
      if (!viteDevServerUrl) {
        throw new Error("--vite-dev-server-url requires a value.");
      }
      continue;
    }
    throw new Error(`Unknown development Electron launch argument: ${value}`);
  }

  return {
    replaceExisting,
    ...whenDefined(viteDevServerUrl, (definedUrl) => ({
      viteDevServerUrl: definedUrl,
    })),
  };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
