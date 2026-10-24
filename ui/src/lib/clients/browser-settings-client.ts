import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type BrowserMode = "headed" | "headless";

export interface BrowserSettingsSnapshot {
  status: "stopped" | "running" | "unavailable";
  mode: BrowserMode;
  executablePath?: string;
  profilePath: string;
  pageCount: number;
  error?: string;
  saved: true;
}

export function fetchBrowserSettings(): Promise<BrowserSettingsSnapshot> {
  return request("/settings/browser");
}

export function saveBrowserMode(mode: BrowserMode): Promise<BrowserSettingsSnapshot> {
  return request("/settings/browser", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export function openBrowserProfile(): Promise<BrowserSettingsSnapshot> {
  return request("/settings/browser/open-profile", { method: "POST" });
}

export function stopManagedBrowser(): Promise<BrowserSettingsSnapshot> {
  return request("/settings/browser/stop", { method: "POST" });
}

async function request(path: string, init?: RequestInit): Promise<BrowserSettingsSnapshot> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof payload?.error === "string" ? payload.error : "Browser settings request failed.");
  }
  return await response.json() as BrowserSettingsSnapshot;
}
