import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { SchedulingQueueSettings } from "@/components/settings/scheduling-queue-settings";
import type { SchedulingSettingsSnapshot } from "@/lib/clients/scheduling-settings-client";

const defaultSnapshot: SchedulingSettingsSnapshot = {
  maximumConcurrentTasks: 3,
  constraints: { minimum: 1, maximum: 64 },
  source: "default",
  editable: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("loads the default limit and explains the queue contract", async () => {
  const fetchMock = vi.fn(async () => jsonResponse(defaultSnapshot));
  vi.stubGlobal("fetch", fetchMock);

  render(<SchedulingQueueSettings />);

  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading scheduling settings...",
  );
  const input = await screen.findByLabelText(
    "Maximum concurrent tasks or workflows",
  );
  await waitFor(() => expect(input).toHaveValue(3));
  expect(input).toHaveAttribute("type", "number");
  expect(input).toHaveAttribute("min", "1");
  expect(input).toHaveAttribute("max", "64");
  expect(input).toHaveAttribute("step", "1");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByText(/Each top-level task or workflow uses one slot/))
    .toHaveTextContent("Excess work waits in FIFO order.");
  expect(screen.getByText(/Each top-level task or workflow uses one slot/))
    .toHaveTextContent(
      "Nested workflow work does not consume another top-level slot.",
    );
  expect(fetchMock).toHaveBeenCalledWith("/api/settings/scheduling", undefined);
});

it("shows dirty and invalid states, then adopts only the successful API response", async () => {
  let resolveSave: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn(
    async (_request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method !== "PATCH") return jsonResponse(defaultSnapshot);
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<SchedulingQueueSettings />);

  const input = await screen.findByLabelText(
    "Maximum concurrent tasks or workflows",
  );
  await waitFor(() => expect(input).toHaveValue(3));
  await user.clear(input);
  await user.type(input, "0");

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter a whole number between 1 and 64.",
  );
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await user.clear(input);
  await user.type(input, "5");
  expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes.");
  const saveButton = screen.getByRole("button", { name: "Save" });
  expect(saveButton).toBeEnabled();
  await user.click(saveButton);

  expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
  expect(input).toBeDisabled();
  const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(patchCall?.[0]).toBe("/api/settings/scheduling");
  expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
    maximumConcurrentTasks: 5,
  });

  resolveSave?.(
    jsonResponse({
      ...defaultSnapshot,
      maximumConcurrentTasks: 4,
      source: "persisted",
    }),
  );
  await waitFor(() => expect(input).toHaveValue(4));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Saved. The new limit is active.",
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

it("disables editing when the effective value is environment-managed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse({
        ...defaultSnapshot,
        maximumConcurrentTasks: 7,
        source: "environment",
        editable: false,
      } satisfies SchedulingSettingsSnapshot),
    ),
  );

  render(<SchedulingQueueSettings />);

  const input = await screen.findByLabelText(
    "Maximum concurrent tasks or workflows",
  );
  await waitFor(() => expect(input).toHaveValue(7));
  expect(input).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByText(/managed by the TEAM_RUNTIME_MAX_CONCURRENT_TASKS/))
    .toHaveTextContent("restart the app");
});

it("uses the stable error code when a save fails and keeps the draft", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH"
        ? jsonResponse(
            {
              error: "Backend wording that the UI must not branch on.",
              code: "settings_persistence_failed",
              retryable: true,
            },
            500,
          )
        : jsonResponse(defaultSnapshot),
    ),
  );
  const user = userEvent.setup();
  render(<SchedulingQueueSettings />);

  const input = await screen.findByLabelText(
    "Maximum concurrent tasks or workflows",
  );
  await waitFor(() => expect(input).toHaveValue(3));
  await user.clear(input);
  await user.type(input, "6");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The limit could not be saved. The previous limit is still active.",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("Backend wording");
  expect(input).toHaveValue(6);
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
