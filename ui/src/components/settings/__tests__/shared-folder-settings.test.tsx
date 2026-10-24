import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { SharedFolderSettings } from "@/components/settings/shared-folder-settings";

/**
 * Settings' list of folders shared with agents (docs/feature-local-folder-access.md,
 * "The person revokes the grant in Settings").
 *
 * Only the network is replaced, by a small in-memory grant list answering
 * `/settings/shared-folder-grants` the way the server does. That revoking stops
 * the agent's next tool call is proved through the real API in
 * tests/integration/shared-folder-grants-settings.test.ts.
 */

const GRANTS_URL = "/api/settings/shared-folder-grants";

function fakeGrantApi(options: { grants: string[]; refuseRevoke?: { status: number; error: string; code: string } }) {
  const grants = [...options.grants];
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url !== GRANTS_URL) return Response.json({ error: `unexpected path: ${url}` }, { status: 500 });
    if (method === "GET") return Response.json({ grants: grants.map((path) => ({ path })) });
    if (method === "DELETE") {
      if (options.refuseRevoke) {
        const { status, ...body } = options.refuseRevoke;
        return Response.json(body, { status });
      }
      const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      const path = typeof parsed === "object" && parsed !== null && "path" in parsed ? parsed.path : undefined;
      const index = grants.findIndex((grant) => grant === path);
      if (index < 0) return Response.json({ error: "Shared folder grant not found.", code: "grant_not_found" }, { status: 404 });
      grants.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, grants };
}

afterEach(() => vi.unstubAllGlobals());

it("lists each shared folder grant and revoking one removes its row", async () => {
  const api = fakeGrantApi({ grants: ["/Users/example/Contracts 2026", "/Users/example/Research"] });
  const user = userEvent.setup();
  render(<SharedFolderSettings />);

  expect(await screen.findByText("/Users/example/Contracts 2026")).toBeInTheDocument();
  expect(screen.getByText("/Users/example/Research")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Revoke /Users/example/Contracts 2026" }));
  await user.click(await screen.findByRole("button", { name: "Revoke folder access" }));

  await waitFor(() => expect(screen.queryByText("/Users/example/Contracts 2026")).not.toBeInTheDocument());
  expect(screen.getByText("/Users/example/Research")).toBeInTheDocument();
  expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([
    { method: "DELETE", url: GRANTS_URL, body: JSON.stringify({ path: "/Users/example/Contracts 2026" }) },
  ]);
  expect(api.grants).toEqual(["/Users/example/Research"]);
});

it("shows the server's error and keeps the row when a revoke fails", async () => {
  fakeGrantApi({
    grants: ["/Users/example/Contracts 2026"],
    refuseRevoke: { status: 503, error: "Shared folder grants are unavailable.", code: "shared_folders_unavailable" },
  });
  const user = userEvent.setup();
  render(<SharedFolderSettings />);

  await user.click(await screen.findByRole("button", { name: "Revoke /Users/example/Contracts 2026" }));
  await user.click(await screen.findByRole("button", { name: "Revoke folder access" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Shared folder grants are unavailable.");
  expect(screen.getByText("/Users/example/Contracts 2026")).toBeInTheDocument();
});

it("shows the server's error when the list cannot be loaded", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(
    { error: "Shared folder grants are unavailable.", code: "shared_folders_unavailable" },
    { status: 503 },
  )));
  render(<SharedFolderSettings />);

  expect(await screen.findByRole("alert")).toHaveTextContent("Shared folder grants are unavailable.");
});
