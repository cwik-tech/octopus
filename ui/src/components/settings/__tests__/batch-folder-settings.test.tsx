import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { BatchFolderSettings } from "@/components/settings/batch-folder-settings";

afterEach(() => vi.unstubAllGlobals());

it("lists and revokes an exact external Batch folder grant", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ grants: [{ path: "/external/files" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<BatchFolderSettings />);

  expect(await screen.findByText("/external/files")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Revoke /external/files" }));
  expect(screen.getByText(/new Batch runs from this folder will be blocked/i)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Revoke folder access" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings/batch-folder-grants",
    expect.objectContaining({ method: "DELETE", body: JSON.stringify({ path: "/external/files" }) }),
  ));
  await waitFor(() => expect(screen.queryByText("/external/files")).not.toBeInTheDocument());
});
