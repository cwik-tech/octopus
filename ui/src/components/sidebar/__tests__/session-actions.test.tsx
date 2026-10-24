import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { RunSessionsSidebar } from "@/components/sidebar/run-sessions-sidebar";
import type { SessionSummary } from "@/lib/models/session-model";

function makeSession(): SessionSummary {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Memory research",
    status: "idle",
    activityType: "chat",
    createdAt: "2026-09-19T12:00:00.000Z",
    updatedAt: "2026-09-19T12:00:00.000Z",
  };
}

function renderSidebar() {
  const onSelect = vi.fn();
  const onDelete = vi.fn();
  function Harness() {
    const [session, setSession] = useState(makeSession);
    return <RunSessionsSidebar
      sessions={[session]} loading={false} error={null} selectedSessionId={session.id}
      deletingSidebarItem={null} queueError={null} queueLoading={false} queueSnapshot={null}
      runWorkspaceView="session" onSelect={onSelect} onDelete={onDelete}
      onQueueSelect={() => undefined} onSchedulesSelect={() => undefined} onSessionUpdated={setSession}
    />;
  }
  render(<Harness />);
  return { user: userEvent.setup(), onSelect, onDelete };
}

afterEach(() => { vi.unstubAllGlobals(); });

test("opens rename with the current name, rejects blanks, and cancels without changing the session", async () => {
  const { user, onSelect } = renderSidebar();
  const actions = screen.getByRole("button", { name: "Session actions for Memory research" });
  await user.click(actions);
  expect(await screen.findAllByRole("menuitem")).toHaveLength(3);
  expect(screen.queryByRole("button", { name: "Delete Memory research" })).not.toBeInTheDocument();
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename session" });
  const input = within(dialog).getByRole("textbox", { name: "Session name" });
  expect(input).toHaveValue("Memory research");
  await waitFor(() => expect(input).toHaveFocus());
  await user.clear(input);
  await user.type(input, "   ");
  expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Memory research" })).toBeInTheDocument();
  await waitFor(() => expect(actions).toHaveFocus());
  expect(onSelect).not.toHaveBeenCalled();
});

test("keeps a failed rename editable and saves the corrected name on retry", async () => {
  // The component environment has no API server; Electron covers real persistence.
  vi.stubGlobal("fetch", vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Rename unavailable" }), { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...makeSession(), title: "Memory notes" }))));
  const { user, onSelect } = renderSidebar();
  await user.click(screen.getByRole("button", { name: "Session actions for Memory research" }));
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const input = await screen.findByRole("textbox", { name: "Session name" });
  await user.clear(input);
  await user.type(input, "  Memory notes  {Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Rename unavailable");
  expect(input).toHaveValue("  Memory notes  ");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Memory notes" })).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
});

test("routes Delete through the existing confirmation without selecting the session", async () => {
  const { user, onSelect, onDelete } = renderSidebar();
  await user.click(screen.getByRole("button", { name: "Session actions for Memory research" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  expect(onDelete).toHaveBeenCalledWith({
    id: makeSession().id, kind: "session", label: "session “Memory research”", allowSkipConfirmation: true,
  });
  expect(onSelect).not.toHaveBeenCalled();
});
