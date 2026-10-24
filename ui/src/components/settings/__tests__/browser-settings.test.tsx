import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { BrowserSettings } from "@/components/settings/browser-settings";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("loads managed Chrome status and persists explicit browser controls", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  let mode: "headed" | "headless" = "headed";
  let status: "stopped" | "running" = "stopped";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body });
    if (url.pathname.endsWith("/settings/browser") && init?.method === "PUT") {
      mode = (body as { mode: "headed" | "headless" }).mode;
    } else if (url.pathname.endsWith("/open-profile")) {
      status = "running";
    } else if (url.pathname.endsWith("/stop")) {
      status = "stopped";
    }
    return jsonResponse({
      status,
      mode,
      executablePath: "/Applications/Google Chrome.app/Chrome",
      profilePath: "/tmp/pipeline-browser-profile",
      pageCount: 0,
      saved: true,
    });
  }));

  render(<BrowserSettings />);
  expect(await screen.findByText("/tmp/pipeline-browser-profile")).toBeInTheDocument();
  expect(screen.getByText("stopped")).toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Headless" }));
  await waitFor(() => expect(calls).toContainEqual({
    path: "/api/settings/browser",
    method: "PUT",
    body: { mode: "headless" },
  }));

  await user.click(screen.getByRole("button", { name: "Open authenticated profile" }));
  expect(await screen.findByText("running")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Headless" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Stop browser" })).toBeEnabled();
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
