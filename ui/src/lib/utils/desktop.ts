import { isValidSessionId } from "@contracts/sessions";

const DESKTOP_API_STORAGE_KEY = "pipeline.desktop-api-base-url";
const DESKTOP_API_PATH = /^\/_pipeline\/[A-Za-z0-9_-]{43}$/;

function getDesktopApiBaseUrlFromHash(): string | null {
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const candidate = validateDesktopApiBaseUrl(
    new URLSearchParams(fragment).get("pipeline-api-base-url"),
  );
  if (candidate) {
    try {
      window.sessionStorage.setItem(DESKTOP_API_STORAGE_KEY, candidate);
    } catch {
      // Storage may be unavailable in privacy-restricted browser contexts.
    }
    return candidate;
  }

  try {
    return validateDesktopApiBaseUrl(
      window.sessionStorage.getItem(DESKTOP_API_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

function validateDesktopApiBaseUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !DESKTOP_API_PATH.test(url.pathname) ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function getApiBaseUrl(): string {
  return (
    getDesktopApiBaseUrlFromHash() ||
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ||
    "/api"
  );
}

export function readInitialSessionId(): string | null {
  const candidate = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pipeline-initial-session');
  return candidate !== null && isValidSessionId(candidate) ? candidate : null;
}

export function readInitialCanvasSessionId(): string | null {
  const candidate = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pipeline-canvas-session')
  return candidate !== null && isValidSessionId(candidate) ? candidate : null
}
