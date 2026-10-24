import { afterEach, expect, test } from "vitest";

import { getApiBaseUrl, readInitialSessionId } from "@/lib/utils/desktop";

const token = "a".repeat(43);
const desktopApiUrl = `http://127.0.0.1:43123/_pipeline/${token}`;

afterEach(() => {
  window.location.hash = "";
  window.sessionStorage.clear();
});

test("desktop API discovery accepts and persists an authenticated loopback URL", () => {
  window.location.hash = new URLSearchParams({
    "pipeline-api-base-url": desktopApiUrl,
  }).toString();

  expect(getApiBaseUrl()).toBe(desktopApiUrl);
  expect(window.sessionStorage.getItem("pipeline.desktop-api-base-url")).toBe(
    desktopApiUrl,
  );
});

test("desktop API discovery survives a document fragment replacing the launch hash", () => {
  window.location.hash = new URLSearchParams({
    "pipeline-api-base-url": desktopApiUrl,
  }).toString();
  expect(getApiBaseUrl()).toBe(desktopApiUrl);

  window.location.hash = "review-section";

  expect(getApiBaseUrl()).toBe(desktopApiUrl);
});

test("desktop API discovery rejects remote and malformed token endpoints", () => {
  for (const unsafeUrl of [
    `https://example.com/_pipeline/${token}`,
    "http://127.0.0.1:43123/health",
    "http://user:password@127.0.0.1:43123/_pipeline/" + token,
  ]) {
    window.location.hash = new URLSearchParams({
      "pipeline-api-base-url": unsafeUrl,
    }).toString();
    expect(getApiBaseUrl()).toBe("/api");
    expect(
      window.sessionStorage.getItem("pipeline.desktop-api-base-url"),
    ).toBeNull();
  }
});

const sessionId = 'ad605beb-dadc-403a-bca4-b05df6e00001';
test('initial desktop session accepts only a valid UUID from its own hash key', () => {
  window.location.hash = new URLSearchParams({ 'pipeline-initial-session': sessionId }).toString();
  expect(readInitialSessionId()).toBe(sessionId);
  window.location.hash = 'pipeline-initial-session=../settings';
  expect(readInitialSessionId()).toBeNull();
  window.location.hash = '';
  expect(readInitialSessionId()).toBeNull();
});
