import { afterEach, expect, it, vi } from "vitest";

import {
  DeepResearchSettingsClientError,
  fetchDeepResearchSettings,
  saveDeepResearchSettings,
  type DeepResearchSettingsSnapshot,
} from "@/lib/clients/deep-research-settings-client";

const defaultSnapshot: DeepResearchSettingsSnapshot = {
  schemaVersion: 3,
  maxDurationMinutes: 20,
  maxResearcherAgents: 8,
  constraints: {
    maxDurationMinutes: { minimum: 5, maximum: 120 },
    maxResearcherAgents: { minimum: 1, maximum: 8 },
  },
  source: "default",
  editable: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses the Deep Research settings GET and PATCH contract", async () => {
  const persistedSnapshot: DeepResearchSettingsSnapshot = {
    ...defaultSnapshot,
    maxDurationMinutes: 45,
    maxResearcherAgents: 4,
    source: "persisted",
  };
  const fetchMock = vi.fn(
    async (_request: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse(init?.method === "PATCH" ? persistedSnapshot : defaultSnapshot),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(fetchDeepResearchSettings()).resolves.toEqual(defaultSnapshot);
  await expect(
    saveDeepResearchSettings({
      maxDurationMinutes: 45,
      maxResearcherAgents: 4,
    }),
  ).resolves.toEqual(persistedSnapshot);

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/settings/deep-research",
    undefined,
  );
  expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/settings/deep-research", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      maxDurationMinutes: 45,
      maxResearcherAgents: 4,
    }),
  });
});

it("preserves stable structured API errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(
        {
          error: "Deep Research settings could not be persisted.",
          code: "settings_persistence_failed",
          retryable: true,
        },
        500,
      ),
    ),
  );

  await expect(
    saveDeepResearchSettings({
      maxDurationMinutes: 45,
      maxResearcherAgents: 4,
    }),
  ).rejects.toMatchObject({
    name: "DeepResearchSettingsClientError",
    message: "Deep Research settings could not be persisted.",
    status: 500,
    code: "settings_persistence_failed",
    retryable: true,
  } satisfies Partial<DeepResearchSettingsClientError>);
});

it("falls back safely when an error response is not the documented envelope", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response("not json", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    ),
  );

  await expect(fetchDeepResearchSettings()).rejects.toMatchObject({
    name: "DeepResearchSettingsClientError",
    message: "503 Service Unavailable",
    status: 503,
    code: "request_failed",
    retryable: false,
  } satisfies Partial<DeepResearchSettingsClientError>);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
