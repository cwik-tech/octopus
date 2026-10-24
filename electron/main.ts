import { ANNOUNCE_SESSION_CHANGED_CHANNEL, REPORT_WINDOW_SESSION_CHANNEL, OPEN_WINDOW_CHANNEL, OPEN_WINDOW_LOAD_TIMEOUT_MS, INITIAL_SESSION_HASH_KEY } from './app-window-constants.js';
import { AppWindowRegistry } from "./app-window-registry.js";
import { cascadeBounds, decideShowTarget, parseOpenWindowRequest, relayTargets } from "./app-windows.js";
import { openAppWindow } from "./open-app-window.js";
import { INITIAL_CANVAS_HASH_KEY, GET_CANVAS_WINDOW_STATE_CHANNEL, CANVAS_WINDOW_STATE_CHANNEL } from './app-window-constants.js'
import type { CanvasWindowState } from '../contracts/canvas-workspace.js'
import { isValidSessionId } from "../contracts/sessions.js";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, shell, screen, type Rectangle } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from 'node:url'
import { whenDefined } from '../core/optional-properties.js'

import { startOctopusDockSwim } from "./octopus-dock-icon.js";
import { startApiServer } from "../server/api-server.js";
import {
  YOUTUBE_TOOL_MODULE_NAME,
  type YoutubeToolModuleOptions,
} from "../server/tools/youtube.js";
import {
  RESEARCH_WEB_TOOL_MODULE_NAME,
  createDesktopAcquisitionSettingsService,
  type ResearchWebToolModuleOptions,
} from "../server/tools/research-web.js";
import type { BrowserToolModuleOptions } from "../server/tools/browser.js";
import { DesktopRunLauncher } from "../domains/run/desktop-run-launcher.js";
import { FileSystemRunStore } from "../domains/run/run-store.js";
import { FileSystemSessionStore } from "../domains/sessions/session-store.js";
import { ProviderSettingsService } from "../services/provider-settings-service.js";
import { McpSettingsService } from "../services/mcp-settings-service.js";
import type { YoutubeMediaTools } from '../services/youtube-tool-service.js';
import { YoutubeSettingsService } from "../services/youtube-settings-service.js";
import { resolveYoutubeBinaries } from "../domains/youtube/youtube-binary-resolver.js";
import { AcquisitionSettingsService } from "../services/acquisition-settings-service.js";
import { TeamFileStore } from "../domains/team-files/team-file-store.js";
import {
  ElectronSessionTaskLauncher,
  resolveDesktopAppRootPath,
} from "./session-task-launcher.js";
import {
  resolveDesktopProjectRootPath,
  seedDesktopProjectRoot,
} from "./project-root.js";
import { ElectronFileParserLauncher } from "./file-parser-launcher.js";
import { buildBundledPiEnvironment } from "../core/pi-runtime.js";
import { buildCliPath } from "../core/cli-path.js";
import {
  developmentDesktopRestartRequestFromEnvironment,
  DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE,
  isAcceptedDevelopmentDesktopRestartRequest,
  isDevelopmentDesktopRestartRequest,
} from "../services/development/development-desktop-restart.js";
import { BatchFolderGrantStore } from '../domains/batches/batch-folder-grant-store.js'
import { DefaultBatchFolderAccessPolicy } from '../domains/batches/batch-folder-access.js'
import { registerBatchFolderPicker } from './batch-folder-picker.js'
import { registerSharedFolderOpener, registerSharedFolderPicker } from './shared-folder-picker.js'
import { requireDesktopHeadlessNodePath } from './headless-node-runtime.js'
import { defaultVoiceControlDir, VOICE_CONTROL_DIR_ENV } from '../domains/voice-control/discovery-files.js'
import type { VoiceControlShowTarget } from '../server/voice-control/voice-control-runtime.js'

interface DesktopApiServer {
  close(): Promise<void>;
  url: string;
}

// Each view has long-lived local streams. Chromium's small HTTP/1 per-host
// pool can otherwise queue transcript reads behind streams waiting for those
// very reads. This exception is limited to our loopback API; renderer stream
// concurrency is bounded separately. Verified in the installed Electron binary.
app.commandLine.appendSwitch('ignore-connections-limit', '127.0.0.1,localhost');

const isTestRun = process.env.PIPELINE_DESKTOP_E2E === "1";
const isHeadlessTestRun = process.env.PIPELINE_DESKTOP_E2E_HEADLESS === "1";
const testUserDataPath = process.env.PIPELINE_DESKTOP_USER_DATA;

if (isHeadlessTestRun && process.platform === "darwin") {
  // Accessory applications do not take over the Dock or menu bar while the
  // hidden Playwright renderer is running.
  app.setActivationPolicy("accessory");
}

if (testUserDataPath) {
  app.setPath("userData", testUserDataPath);
}

const developmentRestartRequest =
  developmentDesktopRestartRequestFromEnvironment(process.env);
const ownsSingleInstanceLock = app.requestSingleInstanceLock(
  developmentRestartRequest ?? {},
);
let apiServer: DesktopApiServer | null = null;
let desktopAppRootPath: string | null = null;
let developmentReplacementInProgress = false;
let apiShutdownComplete = false;
let apiShutdownPromise: Promise<void> | null = null;
let disposeBatchFolderPicker: (() => void) | null = null;
let disposeSharedFolderPicker: (() => void) | null = null;
let disposeSharedFolderOpener: (() => void) | null = null;
const appWindows = new AppWindowRegistry<BrowserWindow>();

function resolveAppRootPath(): string {
  return resolveDesktopAppRootPath({
    ...whenDefined(process.env.PIPELINE_DESKTOP_REPO_ROOT, (appRootOverride) => ({ appRootOverride })),
    isPackaged: app.isPackaged,
    moduleUrl: import.meta.url,
    resourcesPath: process.resourcesPath,
  });
}

function resolveDockIconPath(): string {
  return path.join(resolveAppRootPath(), "public", "icon.png");
}

// macOS reads the dock icon from the packaged bundle's .icns, so an unpackaged
// development run shows Electron's own icon unless we set it explicitly.
function applyDevelopmentDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged || !app.dock) return;
  const iconPath = resolveDockIconPath();
  if (!existsSync(iconPath)) return;
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return;
  app.dock.setIcon(icon);
}

async function prepareProjectRootPath(appRootPath: string): Promise<string> {
  const projectRootPath = resolveDesktopProjectRootPath({
    appRootPath,
    isPackaged: app.isPackaged,
    ...whenDefined(process.env.PIPELINE_DESKTOP_PROJECT_ROOT, (projectRootOverride) => ({ projectRootOverride })),
    userDataPath: app.getPath("userData"),
  });
  await seedDesktopProjectRoot({ appRootPath, projectRootPath });
  return projectRootPath;
}

function resolveWorkspacePath(): string {
  if (process.env.PIPELINE_DESKTOP_WORKSPACE_PATH) {
    return path.resolve(process.env.PIPELINE_DESKTOP_WORKSPACE_PATH);
  }

  return path.join(app.getPath("userData"), "workspace");
}

function testAcquisitionProviderEndpoints(): { readonly brave: string } | undefined {
  if (!isTestRun) return undefined;
  const candidate = process.env.PIPELINE_DESKTOP_E2E_BRAVE_ENDPOINT?.trim();
  if (!candidate) return undefined;
  const endpoint = new URL(candidate);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
  ) {
    throw new Error("The Electron E2E Brave endpoint must be a loopback HTTP URL.");
  }
  return { brave: endpoint.href };
}

async function resolveDesktopYoutubeMediaTools(appRootPath: string): Promise<YoutubeMediaTools> {
  let youtubeBinariesUnavailableReason: string | undefined;
  const resolvedYoutubeBinaries = await resolveYoutubeBinaries({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    developmentDirectory: path.join(appRootPath, "build", "youtube-tools"),
  }).catch((error: unknown) => {
    youtubeBinariesUnavailableReason =
      error instanceof Error ? error.message : String(error);
    console.error(
      `Bundled YouTube media tools are unavailable: ${youtubeBinariesUnavailableReason}`,
    );
    return undefined;
  });

  return {
    ...(resolvedYoutubeBinaries ? {
      youtubeBinaries: {
        ytDlpPath: resolvedYoutubeBinaries.ytDlp.path,
        ytDlpVersion: resolvedYoutubeBinaries.ytDlp.version,
        ytDlpSha256: resolvedYoutubeBinaries.ytDlp.sha256,
        ffmpegPath: resolvedYoutubeBinaries.ffmpeg.path,
        ffmpegVersion: resolvedYoutubeBinaries.ffmpeg.version,
        ffmpegSha256: resolvedYoutubeBinaries.ffmpeg.sha256,
        ffprobePath: resolvedYoutubeBinaries.ffprobe.path,
        ffprobeVersion: resolvedYoutubeBinaries.ffprobe.version,
        ffprobeSha256: resolvedYoutubeBinaries.ffprobe.sha256,
      },
    } : {}),
    ...(youtubeBinariesUnavailableReason
      ? { binariesUnavailableReason: youtubeBinariesUnavailableReason }
      : {}),
  };
}

async function startDesktopApi(
  appRootPath: string,
  projectRootPath: string,
  providerSettings: ProviderSettingsService,
  mcpSettings: McpSettingsService,
  youtubeSettings: YoutubeSettingsService,
  acquisitionSettings: AcquisitionSettingsService,
  batchFolderGrantStore: BatchFolderGrantStore,
  sharedFolderGrantStore: BatchFolderGrantStore,
): Promise<DesktopApiServer> {
  const workspacePath = resolveWorkspacePath();
  const runLauncher = new DesktopRunLauncher(appRootPath, providerSettings);
  const taskLauncher = new ElectronSessionTaskLauncher(
    appRootPath,
    projectRootPath,
  );
  const sessionStore = new FileSystemSessionStore(workspacePath);
  taskLauncher.setRuntimeEnvironmentProvider(() =>
    providerSettings.runtimeEnvironment(),
  );

  const server = await startApiServer({
    apiToken: randomBytes(32).toString("base64url"),
    brokerToken: randomBytes(32).toString("base64url"),
    store: new FileSystemRunStore(workspacePath),
    launcher: runLauncher,
    taskLauncher,
    fileParserLauncher: new ElectronFileParserLauncher(appRootPath),
    sessionStore,
    recoverInterruptedTasks: true,
    teamFileStore: new TeamFileStore(workspacePath),
    workflowsRegistryPath: path.join(
      projectRootPath,
      "workflows",
      "registry.yaml",
    ),
    repoRootPath: projectRootPath,
    resourceLibraryRootPath: path.join(app.getPath("userData"), "resource-library"),
    builtinResourceRootPath: appRootPath,
    host: "127.0.0.1",
    port: 0,
    workspacePath,
    browserProfilePath: path.join(app.getPath("userData"), "browser-profile"),
    providerSettingsService: providerSettings,
    mcpSettingsService: mcpSettings,
    batchFolderGrantStore,
    sharedFolderGrantStore,
    // Shared folders may not overlap the app's own data (SEC-3).
    appDataPath: app.getPath("userData"),
    // Outside apps such as a voice layer find Octopus through this folder
    // (docs/feature-voice-control-mcp.md). Their token is minted per launch
    // and is not the API token.
    voiceControl: {
      mcpToken: randomBytes(32).toString("base64url"),
      // A test run keeps its descriptor inside its own user data, so it never
      // advertises itself to a voice layer the person is running, unless the
      // run names a folder itself.
      discoveryDir:
        isTestRun && !process.env[VOICE_CONTROL_DIR_ENV]
          ? path.join(app.getPath("userData"), "voice-control")
          : defaultVoiceControlDir(),
      show: showForVoiceControl,
      sessionChanged: refreshVoiceSession,
    },
    batchFolderAccessPolicy: new DefaultBatchFolderAccessPolicy({
      workspacePath,
      repoRootPath: projectRootPath,
      listGrants: () => batchFolderGrantStore.list(),
    }),
    toolModuleOptions: {
      [YOUTUBE_TOOL_MODULE_NAME]: {
        settingsService: youtubeSettings,
        resolveMediaTools: () => resolveDesktopYoutubeMediaTools(appRootPath),
      } satisfies YoutubeToolModuleOptions,
      [RESEARCH_WEB_TOOL_MODULE_NAME]: {
        settingsService: acquisitionSettings,
        // The unified research-activity favicon route answers for pages this
        // tool acquired, so it needs the same loopback allowance the browser
        // module gets for an end-to-end run's fixture site.
        allowLoopbackSiteIcons: isTestRun,
      } satisfies ResearchWebToolModuleOptions,
      browser: {
        // An end-to-end run serves its own fixture site on loopback, so site
        // icons have to be fetchable there. A shipped desktop never sets this.
        allowLoopbackSiteIcons: isTestRun,
      } satisfies BrowserToolModuleOptions,
    },
    onListening: async ({ brokerUrl }) => {
      // Provider CLI children receive the broker-scoped URL only — never the
      // master API token embedded in `url`.
      if (!brokerUrl) {
        throw new Error("Desktop API did not provide a broker-scoped provider URL");
      }
      providerSettings.setBrokerUrl(brokerUrl);
      // The address is already known. Resolving the runtime environment here
      // probes every CLI and would delay the main window until discovery ends.
      sessionStore.setConfiguredProviderBrokerUrl(brokerUrl);
    },
  });
  return server;
}

function approvedExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function openExternalUrl(value: string): void {
  const approvedUrl = approvedExternalUrl(value);
  if (!approvedUrl) return;

  void shell.openExternal(approvedUrl).catch((error) => {
    console.error(
      `Failed to open external URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function secureWindowNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  const preventNavigation = (
    event: Electron.Event,
    navigationUrl: string,
  ): void => {
    event.preventDefault();
    openExternalUrl(navigationUrl);
  };
  // Only the application can load the isolated wrapper, and only that wrapper
  // can create its srcdoc document. Generated content cannot navigate a frame.
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    const wrapperUrl = new URL("./canvas-preview.html", window.webContents.mainFrame.url).href;
    const loadsWrapper = event.initiator === window.webContents.mainFrame && event.url === wrapperUrl;
    const loadsDocument = event.initiator?.url === wrapperUrl && event.url === "about:srcdoc";
    if (!loadsWrapper && !loadsDocument) event.preventDefault();
  });
  window.webContents.on("will-navigate", preventNavigation);
  window.webContents.on("will-redirect", preventNavigation);
}

function rendererHash(apiBaseUrl: string): string {
  return new URLSearchParams({
    "pipeline-api-base-url": apiBaseUrl,
  }).toString();
}

const canvasWindows = new Map<string, BrowserWindow>()
const canvasOpenings = new Map<string, Promise<void>>()
let canvasWindowEpoch = 0

function canvasWindowState(sessionId: string): CanvasWindowState {
  const window = canvasWindows.get(sessionId)
  return { sessionId, detached: window !== undefined && !window.isDestroyed(), epoch: canvasWindowEpoch }
}
function announceCanvasWindowState(sessionId: string): void {
  canvasWindowEpoch += 1
  const state = canvasWindowState(sessionId)
  for (const entry of appWindows.entries()) appWindows.windowById(entry.id)?.webContents.send(CANVAS_WINDOW_STATE_CHANNEL, state)
}

function createWindow(kind: 'startup' | 'app', bounds?: Rectangle): BrowserWindow {
  const isStartup = kind === 'startup';
  const window = new BrowserWindow({
    width: isStartup ? 520 : 1440,
    height: isStartup ? 360 : 920,
    ...bounds,
    minWidth: isStartup ? 520 : Math.min(1100, bounds?.width ?? 1100),
    minHeight: isStartup ? 360 : Math.min(720, bounds?.height ?? 720),
    resizable: !isStartup,
    maximizable: !isStartup,
    fullscreenable: !isStartup,
    title: "Octopus",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Center the traffic lights in the sidebar's 44px (h-11) top strip, which
    // pads its content 78px from the left to clear them.
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : {}),
    // Match --background in ui/src/index.css so the window does not flash
    // another color before the renderer paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1928" : "#f4f6fe",
    show: false,
    webPreferences: {
      backgroundThrottling: !isHeadlessTestRun,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.platform === 'darwin') window.setWindowButtonVisibility(!isStartup);
  appWindows.add(window);
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) appWindows.setSessionHint(window.webContents, null);
  });

  secureWindowNavigation(window);

  if (!isHeadlessTestRun) {
    window.once("ready-to-show", () => {
      window.show();
    });
  }

  return window;
}

async function loadAppWindow(
  window: BrowserWindow,
  apiBaseUrl: string,
  repoRootPath: string,
  initialSessionId: string | null = null,
  expandStartup = true,
  canvasSessionId: string | null = null,
): Promise<void> {
  if (expandStartup) window.webContents.once('dom-ready', () => {
    if (window.isDestroyed()) return;
    window.setResizable(true);
    window.setMaximizable(true);
    window.setFullScreenable(true);
    window.setMinimumSize(1100, 720);
    window.setSize(1440, 920);
    window.center();
    if (process.platform === 'darwin') window.setWindowButtonVisibility(true);
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    const rendererUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    rendererUrl.hash = appRendererHash(apiBaseUrl, initialSessionId, canvasSessionId);
    await window.loadURL(rendererUrl.toString());
  } else {
    await window.loadFile(path.join(repoRootPath, "ui", "dist", "index.html"), {
      hash: appRendererHash(apiBaseUrl, initialSessionId, canvasSessionId),
    });
  }
}

function appRendererHash(apiBaseUrl: string, initialSessionId: string | null, canvasSessionId: string | null = null): string {
  const hash = new URLSearchParams(rendererHash(apiBaseUrl));
  if (initialSessionId) hash.set(INITIAL_SESSION_HASH_KEY, initialSessionId);
  if (canvasSessionId) hash.set(INITIAL_CANVAS_HASH_KEY, canvasSessionId);
  return hash.toString();
}

async function openRequestedWindow(request: import('./app-windows.js').OpenWindowRequest, source: BrowserWindow | null): Promise<void> {
  if (!apiServer) throw new Error('Desktop API is not ready');
  const url = apiServer.url;
  const workArea = source ? screen.getDisplayMatching(source.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
  const bounds = cascadeBounds(source?.getBounds() ?? null, workArea);
  if (request.kind === 'canvas') {
    const opening = canvasOpenings.get(request.sessionId)
    if (opening) return opening
    const existing = canvasWindows.get(request.sessionId)
    if (existing && !existing.isDestroyed()) {
      if (!isHeadlessTestRun) { existing.show(); existing.focus() }
      return
    }
    const pending = openAppWindow({
      create: () => {
        const window = createWindow('app', bounds)
        canvasWindows.set(request.sessionId, window)
        window.on('closed', () => {
          if (canvasWindows.get(request.sessionId) !== window) return
          canvasWindows.delete(request.sessionId)
          announceCanvasWindowState(request.sessionId)
        })
        return window
      },
      load: (window) => loadAppWindow(window, url, desktopAppRootPath ?? resolveAppRootPath(), null, false, request.sessionId),
      timeoutMs: OPEN_WINDOW_LOAD_TIMEOUT_MS,
      setTimer: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) },
    })
    canvasOpenings.set(request.sessionId, pending)
    try { await pending; announceCanvasWindowState(request.sessionId) }
    finally { canvasOpenings.delete(request.sessionId) }
    return
  }
  await openAppWindow({
    create: () => createWindow('app', bounds),
    load: (window) => loadAppWindow(window, url, desktopAppRootPath ?? resolveAppRootPath(), request.kind === 'session' ? request.sessionId : null, false),
    timeoutMs: OPEN_WINDOW_LOAD_TIMEOUT_MS,
    setTimer: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
  });
}

ipcMain.handle(OPEN_WINDOW_CHANNEL, async (event, value: unknown, ...extra: unknown[]) => {
  const source = appWindows.trustedWindowFor(event.sender, event.senderFrame);
  const request = parseOpenWindowRequest(value);
  if (!source || !request || extra.length !== 0) throw new Error('Window opening requires a trusted main frame and a valid request');
  await openRequestedWindow(request, source);
});

ipcMain.handle(GET_CANVAS_WINDOW_STATE_CHANNEL, (event, sessionId: unknown, ...extra: unknown[]) => {
  if (!appWindows.trustedWindowFor(event.sender, event.senderFrame) || extra.length !== 0 || typeof sessionId !== 'string' || !isValidSessionId(sessionId)) {
    throw new Error('Canvas state requires a trusted main frame and valid session')
  }
  return canvasWindowState(sessionId)
})

ipcMain.on(ANNOUNCE_SESSION_CHANGED_CHANNEL, (event, sessionId: unknown, ...extra: unknown[]) => {
  const source = appWindows.trustedWindowFor(event.sender, event.senderFrame);
  if (!source || extra.length !== 0 || typeof sessionId !== 'string' || !isValidSessionId(sessionId)) return;
  const targets = relayTargets(appWindows.entries().map((entry) => ({ id: entry.id, destroyed: false })), source.id);
  for (const id of targets) appWindows.windowById(id)?.webContents.send(VOICE_SESSION_CHANGED_CHANNEL, { sessionId });
});

ipcMain.on(REPORT_WINDOW_SESSION_CHANNEL, (event, sessionId: unknown, ...extra: unknown[]) => {
  const source = appWindows.trustedWindowFor(event.sender, event.senderFrame);
  if (!source || extra.length !== 0 || (sessionId !== null && (typeof sessionId !== 'string' || !isValidSessionId(sessionId)))) return;
  appWindows.setSessionHint(event.sender, sessionId);
});

async function restoreMainWindow(): Promise<void> {
  const window = appWindows.latest();
  if (window) {
    if (isHeadlessTestRun) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }

  if (!apiServer) return;
  await loadAppWindow(
    createWindow('app'),
    apiServer.url,
    desktopAppRootPath ?? resolveAppRootPath(),
  );
}

/** The renderer opens the session this names (ui/src/hooks/use-voice-navigation.ts). */
const VOICE_NAVIGATE_CHANNEL = "pipeline:voice-navigate";
const VOICE_SESSION_CHANGED_CHANNEL = "pipeline:voice-session-changed";

function refreshVoiceSession(sessionId: string): void {
  for (const entry of appWindows.entries()) appWindows.windowById(entry.id)?.webContents.send(VOICE_SESSION_CHANGED_CHANNEL, { sessionId });
}

/**
 * Brings the window forward with a session open, for a voice layer's `show`.
 * The server has already checked that the session exists.
 */
async function showForVoiceControl(target: VoiceControlShowTarget): Promise<void> {
  const decision = decideShowTarget(target.sessionId, appWindows.entries(), [...canvasWindows.values()].map((window) => window.id));
  if (decision.action === 'create') {
    await openRequestedWindow({ kind: 'session', sessionId: target.sessionId }, null);
    return;
  }
  const window = appWindows.windowById(decision.windowId);
  if (!window) throw new Error('Octopus has no window to show it in.');
  if (!isHeadlessTestRun) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  }
  window.webContents.send(VOICE_NAVIGATE_CHANNEL, {
    sessionId: target.sessionId,
    ...(target.taskId === undefined ? {} : { taskId: target.taskId }),
  });
}

async function loadStartupWindow(window: BrowserWindow, appRootPath: string): Promise<void> {
  // Paint the compact loading page before filesystem setup. Expand this same
  // window when the main renderer is ready, without opening a second window.
  const painted = new Promise<void>((resolve) => window.once('ready-to-show', resolve));
  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(new URL('startup.html', process.env.VITE_DEV_SERVER_URL).href);
  } else {
    await window.loadFile(path.join(appRootPath, 'ui', 'dist', 'startup.html'));
  }
  await painted;
}

async function boot() {
  desktopAppRootPath = resolveAppRootPath();
  const window = createWindow('startup');
  await loadStartupWindow(window, desktopAppRootPath);
  const headlessNodePath = requireDesktopHeadlessNodePath(process.execPath)
  Object.assign(
    process.env,
    buildBundledPiEnvironment(
      desktopAppRootPath,
      {
        ...process.env,
        PATH: buildCliPath(process.env.PATH),
      },
      headlessNodePath,
    ),
  );
  const projectRootPath = await prepareProjectRootPath(desktopAppRootPath);
  const encryptSecret = (value: string): string => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system.");
    }
    return safeStorage.encryptString(value).toString("base64");
  };
  const providerSecretCodec = {
    encrypt: encryptSecret,
    decrypt(value: string): string {
      if (!safeStorage.isEncryptionAvailable()) return "";
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    },
  };
  // MCP configuration must never silently substitute missing secret material.
  // Doing so could start a local command or contact a server with the wrong identity.
  const mcpSecretCodec = {
    encrypt: encryptSecret,
    decrypt(value: string): string {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("Secure credential storage is unavailable on this system.");
      }
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    },
  };
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(app.getPath("userData"), "provider-settings.json"),
    secretCodec: providerSecretCodec,
  });
  const mcpSettings = new McpSettingsService({
    storagePath: path.join(app.getPath("userData"), "mcp-settings.json"),
    secretCodec: mcpSecretCodec,
  });
  const youtubeSettings = new YoutubeSettingsService({
    storagePath: path.join(app.getPath("userData"), "youtube-settings.json"),
    secretCodec: mcpSecretCodec,
  });
  const acquisitionSettings = createDesktopAcquisitionSettingsService({
    storagePath: path.join(
      app.getPath("userData"),
      "research-acquisition-settings.json",
    ),
    secretCodec: mcpSecretCodec,
    providerSettings,
    isTestRun,
    ...whenDefined(testAcquisitionProviderEndpoints(), (providerEndpoints) => ({
      providerEndpoints,
    })),
  });
  const batchFolderGrantStore = new BatchFolderGrantStore(
    path.join(app.getPath('userData'), 'batch-folder-grants.json'),
  );
  await batchFolderGrantStore.initialize();
  // Folders shared with agents keep their own grants, so a pick for one
  // feature never widens what the other admits.
  const sharedFolderGrantStore = new BatchFolderGrantStore(
    path.join(app.getPath('userData'), 'shared-folder-grants.json'),
  );
  await sharedFolderGrantStore.initialize();
  apiServer = await startDesktopApi(
    desktopAppRootPath,
    projectRootPath,
    providerSettings,
    mcpSettings,
    youtubeSettings,
    acquisitionSettings,
    batchFolderGrantStore,
    sharedFolderGrantStore,
  );
  disposeBatchFolderPicker = registerBatchFolderPicker({
    ipcMain,
    showOpenDialog: (owner) => dialog.showOpenDialog(owner as BrowserWindow, {
      properties: ['openDirectory'],
    }),
    grantStore: batchFolderGrantStore,
    workspacePath: resolveWorkspacePath(),
    repoRootPath: projectRootPath,
    getOwnerWindow: () => appWindows.latest(),
    getOwnerWindowForSender: (sender, frame) => appWindows.trustedWindowFor(sender, frame),
    ownerForSender: (sender) => BrowserWindow.fromWebContents(sender as Electron.WebContents),
  });
  disposeSharedFolderPicker = registerSharedFolderPicker({
    ipcMain,
    showOpenDialog: (owner) => dialog.showOpenDialog(owner as BrowserWindow, {
      properties: ['openDirectory'],
      buttonLabel: 'Add folder',
    }),
    grantStore: sharedFolderGrantStore,
    protectedPaths: [app.getPath('userData'), resolveWorkspacePath()],
    getOwnerWindow: () => appWindows.latest(),
    getOwnerWindowForSender: (sender, frame) => appWindows.trustedWindowFor(sender, frame),
    ownerForSender: (sender) => BrowserWindow.fromWebContents(sender as Electron.WebContents),
  });
  disposeSharedFolderOpener = registerSharedFolderOpener({
    ipcMain,
    grantStore: sharedFolderGrantStore,
    // Read at call time so a journey can replace shell.openPath.
    openPath: (folderPath) => shell.openPath(folderPath),
    getOwnerWindow: () => appWindows.latest(),
    getOwnerWindowForSender: (sender, frame) => appWindows.trustedWindowFor(sender, frame),
    ownerForSender: (sender) => BrowserWindow.fromWebContents(sender as Electron.WebContents),
  });
  if (!window.isDestroyed()) {
    await loadAppWindow(window, apiServer.url, desktopAppRootPath);
  }
}

if (!ownsSingleInstanceLock) {
  if (developmentRestartRequest) {
    app.exit(DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE);
  } else {
    app.quit();
  }
} else {
  app.on(
    "second-instance",
    (_event, _argv, _workingDirectory, additionalData) => {
      const currentRepositoryRoot =
        desktopAppRootPath ?? resolveAppRootPath();
      if (
        !developmentReplacementInProgress &&
        isAcceptedDevelopmentDesktopRestartRequest({
          additionalData,
          currentRepositoryRoot,
          isPackaged: app.isPackaged,
        })
      ) {
        developmentReplacementInProgress = true;
        app.quit();
        return;
      }

      if (isDevelopmentDesktopRestartRequest(additionalData)) return;

      void restoreMainWindow().catch((error) => {
        console.error(
          error instanceof Error ? error.stack || error.message : String(error),
        );
      });
    },
  );

  app.whenReady().then(() => {
    applyDevelopmentDockIcon();
    const stopDockSwim = startOctopusDockSwim(resolveDockIconPath());
    app.once("will-quit", stopDockSwim);

    void boot().catch((error) => {
      console.error(
        error instanceof Error ? error.stack || error.message : String(error),
      );
      app.quit();
    });

    app.on("activate", () => {
      void restoreMainWindow().catch((error) => {
        console.error(
          error instanceof Error ? error.stack || error.message : String(error),
        );
      });
    });
  }).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.stack || error.message : String(error),
    );
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || isTestRun) {
    app.quit();
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => app.quit());
}

app.on("before-quit", (event) => {
  if (apiShutdownComplete) return;
  if (apiShutdownPromise) {
    event.preventDefault();
    return;
  }
  if (!apiServer) return;

  event.preventDefault();
  const server = apiServer;
  apiServer = null;
  disposeBatchFolderPicker?.();
  disposeBatchFolderPicker = null;
  disposeSharedFolderPicker?.();
  disposeSharedFolderPicker = null;
  disposeSharedFolderOpener?.();
  disposeSharedFolderOpener = null;
  apiShutdownPromise = server.close()
    .catch((error) => {
      console.error(
        `Desktop API shutdown failed: ${
          error instanceof Error ? error.stack || error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      apiShutdownComplete = true;
      app.quit();
    });
});
