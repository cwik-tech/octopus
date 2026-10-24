import { afterEach, expect, it, vi } from "vitest";

import {
  fetchSchedulingSettings,
  saveSchedulingSettings,
  SchedulingSettingsClientError,
  type SchedulingSettingsSnapshot,
} from "@/lib/clients/scheduling-settings-client";

const defaultSnapshot: SchedulingSettingsSnapshot = {
  maximumConcurrentTasks: 3,
  constraints: { minimum: 1, maximum: 64 },
  source: "default",
  editable: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses the scheduling settings GET and PATCH contract", async () => {
  const persistedSnapshot: SchedulingSettingsSnapshot = {
    ...defaultSnapshot,
    maximumConcurrentTasks: 5,
    source: "persisted",
  };
  const fetchMock = vi.fn(
    async (_request: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse(init?.method === "PATCH" ? persistedSnapshot : defaultSnapshot),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(fetchSchedulingSettings()).resolves.toEqual(defaultSnapshot);
  await expect(saveSchedulingSettings(5)).resolves.toEqual(persistedSnapshot);

  expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/settings/scheduling", undefined);
  expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/settings/scheduling", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maximumConcurrentTasks: 5 }),
  });
});

it("preserves stable API error metadata for code-based handling", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(
        {
          error: "Task admission is still recovering.",
          code: "task_admission_recovering",
          retryable: true,
        },
        503,
      ),
    ),
  );

  await expect(saveSchedulingSettings(4)).rejects.toMatchObject({
    name: "SchedulingSettingsClientError",
    message: "Task admission is still recovering.",
    status: 503,
    code: "task_admission_recovering",
    retryable: true,
  } satisfies Partial<SchedulingSettingsClientError>);
});

it("falls back safely when an error response is not the documented envelope", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response("not json", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    ),
  );

  await expect(fetchSchedulingSettings()).rejects.toMatchObject({
    name: "SchedulingSettingsClientError",
    message: "500 Internal Server Error",
    status: 500,
    code: "request_failed",
    retryable: false,
  } satisfies Partial<SchedulingSettingsClientError>);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
