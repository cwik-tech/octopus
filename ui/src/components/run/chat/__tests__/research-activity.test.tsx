import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import {
  ResearchActivity as ResearchActivityDisclosure,
  ResearchSources,
} from "@/components/run/chat/research-activity-list";
import type { ResearchActivity } from "@/lib/clients/research-activity-client";
import { listResearchActivity } from "@/lib/clients/research-activity-client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("renders one compact, collapsed research chain with errors and attachments", async () => {
  render(
    <ResearchActivityDisclosure
      activities={[
        makeActivity({
          activityId: "activity-failed",
          source: "browser",
          action: "click",
          kind: "supporting",
          state: "failed",
          createdAt: "2026-07-16T10:00:00.000Z",
          error: { code: "element_not_found", message: "The element reference is stale." },
        }),
        makeActivity({
          activityId: "activity-download",
          source: "browser",
          action: "download",
          kind: "supporting",
          state: "completed",
          createdAt: "2026-07-16T09:59:00.000Z",
          title: "Research report",
          attachment: {
            id: "attachment-1",
            kind: "download",
            name: "report.pdf",
            relativePath: "browser-downloads/report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 128,
          },
        }),
      ]}
      resolved
    />,
  );
  expect(await screen.findByLabelText("Web research activity")).toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: /Research activity: 2 steps/ });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("row")).not.toBeInTheDocument();

  await userEvent.setup().click(trigger);
  expect(screen.getAllByRole("row", { name: /^Research activity/ })).toHaveLength(2);
  expect(screen.getByText("The page element was no longer there")).toBeInTheDocument();
  // Browser-generated binaries keep their own route; the projection unifies the
  // read model, not the storage of what the browser produced.
  const attachment = await screen.findByRole("link", { name: "Open research attachment report.pdf" });
  expect(attachment).toHaveAttribute(
    "href",
    "/api/sessions/session-1/browser-activity/activity-download/attachment",
  );
});

it("validates research activity from both tools before exposing it", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
    activities: [
      {
        activityId: "valid-browser",
        source: "browser",
        sessionId: "session-1",
        runId: "root-run",
        assignmentId: "research-run",
        activityScopeId: "lane-1",
        agentPath: "agents/web-researcher",
        toolCallId: "valid-browser-call",
        action: "open",
        kind: "page",
        state: "completed",
        createdAt: "2026-08-18T12:00:00.000Z",
        updatedAt: "2026-08-18T12:00:01.000Z",
      },
      {
        activityId: "valid-search",
        source: "research-web",
        sessionId: "session-1",
        runId: "root-run",
        assignmentId: "research-run",
        activityScopeId: "lane-1",
        agentPath: "agents/web-researcher",
        toolCallId: "valid-search-call",
        providerCallOrdinal: 0,
        action: "search",
        kind: "search",
        state: "completed",
        createdAt: "2026-08-18T12:00:02.000Z",
        updatedAt: "2026-08-18T12:00:03.000Z",
        resultCount: 3,
        searchProviders: ["brave"],
      },
      {
        activityId: 42,
        source: "research-web",
        sessionId: "session-1",
        runId: "root-run",
        assignmentId: "research-run",
        agentPath: "agents/web-researcher",
        toolCallId: "invalid-call",
        action: "open",
        kind: "page",
        state: "completed",
        createdAt: "2026-08-18T12:00:00.000Z",
        updatedAt: "2026-08-18T12:00:01.000Z",
      },
      {
        activityId: "unknown-kind",
        source: "research-web",
        sessionId: "session-1",
        runId: "root-run",
        assignmentId: "research-run",
        activityScopeId: "lane-1",
        agentPath: "agents/web-researcher",
        toolCallId: "unknown-kind-call",
        action: "search",
        kind: "telepathy",
        state: "completed",
        createdAt: "2026-08-18T12:00:04.000Z",
        updatedAt: "2026-08-18T12:00:05.000Z",
      },
    ],
  })));

  await expect(listResearchActivity("session-1")).resolves.toEqual([
    expect.objectContaining({
      activityId: "valid-browser",
      source: "browser",
      kind: "page",
      activityScopeId: "lane-1",
    }),
    expect.objectContaining({
      activityId: "valid-search",
      source: "research-web",
      kind: "search",
      providerCallOrdinal: 0,
      resultCount: 3,
      searchProviders: ["brave"],
    }),
  ]);
});

it("names the search provider and result count of a completed search", () => {
  render(
    <ResearchActivityDisclosure
      activities={[makeActivity({
        activityId: "search",
        action: "search",
        kind: "search",
        state: "completed",
        resultCount: 3,
        searchProviders: ["brave"],
      })]}
      resolved={false}
    />,
  );

  expect(screen.getByText("Searched Brave")).toBeInTheDocument();
  expect(screen.getByText("3 results")).toBeInTheDocument();
});

it("says a search is running without claiming a provider yet", () => {
  render(
    <ResearchActivityDisclosure
      activities={[makeActivity({
        activityId: "search",
        action: "search",
        kind: "search",
        state: "running",
      })]}
      resolved={false}
    />,
  );

  expect(screen.getByText("Searching the web")).toBeInTheDocument();
  expect(screen.queryByText(/^Searched/)).not.toBeInTheDocument();
});

it("names the page an acquisition is still reading", () => {
  render(
    <ResearchActivityDisclosure
      activities={[makeActivity({
        activityId: "acquire",
        action: "acquire",
        kind: "page",
        state: "running",
        url: "https://example.com/report",
      })]}
      resolved={false}
    />,
  );

  expect(screen.getByText("Reading example.com")).toBeInTheDocument();
  // Nothing was read yet, so it is not offered as a page to open.
  expect(screen.queryByRole("button", { name: /^Open https/ })).not.toBeInTheDocument();
});

it("never presents a search as a page the researcher opened", () => {
  render(
    <ResearchActivityDisclosure
      activities={[makeActivity({
        activityId: "search",
        action: "search",
        kind: "search",
        state: "completed",
        resultCount: 3,
        searchProviders: ["brave"],
      })]}
      resolved
      expandedByDefault
    />,
  );

  expect(screen.getByRole("button", { name: /Research activity: 1 step$/ }))
    .toBeInTheDocument();
});

it("describes a terminal failure by what happened, not by which tool it happened in", () => {
  // One component now renders both tools, so copy that names the browser
  // describes a cancelled or timed-out `research_web` step as something it
  // never was.
  render(
    <ResearchActivityDisclosure
      activities={[
        makeActivity({
          activityId: "cancelled-search",
          action: "search",
          kind: "search",
          state: "cancelled",
          error: { code: "cancelled", message: "The turn was cancelled." },
        }),
        makeActivity({
          activityId: "timed-out",
          action: "acquire",
          state: "failed",
          url: "https://slow.example/report",
          error: { code: "timeout", message: "The source did not respond." },
        }),
        makeActivity({
          activityId: "unknown-code",
          action: "acquire",
          state: "failed",
          url: "https://odd.example/report",
          error: { code: "source_integrity", message: "The source failed verification." },
        }),
      ]}
      resolved={false}
    />,
  );

  expect(screen.getByText("The search was cancelled")).toBeInTheDocument();
  expect(screen.getByText("The source did not respond in time")).toBeInTheDocument();
  expect(screen.getByText("Could not read odd.example")).toBeInTheDocument();
  expect(screen.queryByText(/browser action failed/i)).not.toBeInTheDocument();
});

it("still names a managed-browser failure the way the browser reported it", () => {
  render(
    <ResearchActivityDisclosure
      activities={[makeActivity({
        activityId: "blocked",
        source: "browser",
        action: "open",
        state: "failed",
        url: "https://blocked.example/page",
        error: { code: "source_blocked", message: "Host blocked for this turn." },
      })]}
      resolved={false}
    />,
  );

  expect(
    screen.getByText("Skipped after an earlier failure on this host"),
  ).toBeInTheDocument();
});

it("opens during research and collapses automatically when the answer resolves", async () => {
  const activity = makeActivity({
    activityId: "activity-running",
    state: "running",
    url: "https://example.com/research",
  });
  const view = render(
    <ResearchActivityDisclosure activities={[activity]} resolved={false} />,
  );
  const trigger = screen.getByRole("button", { name: /research activity:/i });
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  view.rerender(
    <ResearchActivityDisclosure
      activities={[{ ...activity, state: "completed" }]}
      resolved
    />,
  );
  await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
});

it("shows only cited pages that completed successfully as answer sources", () => {
  render(
    <ResearchSources
      activities={[
        makeActivity({
          activityId: "used",
          url: "https://used.example/report",
          title: "Used report",
        }),
        makeActivity({
          activityId: "unused",
          url: "https://unused.example/report",
          title: "Unused report",
        }),
      ]}
      answer="Supported claim: https://used.example/report"
    />,
  );
  expect(screen.getByRole("button", { name: "Used 1 sources" })).toBeInTheDocument();
  expect(screen.queryByText("Unused report")).not.toBeInTheDocument();
});

it("stays open between two research calls instead of flickering shut", async () => {
  vi.useFakeTimers();
  const finished = makeActivity({ activityId: "step-1", url: "https://example.com/research" });
  const view = render(
    <ResearchActivityDisclosure activities={[finished]} resolved settleMs={3_000} />,
  );
  const trigger = screen.getByRole("button", { name: /research activity/i });

  // Every recorded step is terminal, but the next call has not been recorded yet.
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  view.rerender(
    <ResearchActivityDisclosure
      activities={[
        finished,
        makeActivity({ activityId: "step-2", state: "running", url: "https://example.com/research" }),
      ]}
      resolved={false}
      settleMs={3_000}
    />,
  );
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
});

it("collapses a research group that finishes without an answer", async () => {
  vi.useFakeTimers();
  render(
    <ResearchActivityDisclosure
      activities={[makeActivity({ activityId: "step-1", url: "https://example.com/research" })]}
      resolved
      settleMs={3_000}
    />,
  );
  const trigger = screen.getByRole("button", { name: /research activity/i });

  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

it("says it is running while unsettled and names itself plainly once settled", async () => {
  vi.useFakeTimers();
  render(
    <ResearchActivityDisclosure
      activities={[makeActivity({ activityId: "step-1", url: "https://example.com/research" })]}
      resolved
      settleMs={3_000}
    />,
  );

  // Label and open state are read from one value, so they cannot disagree.
  const running = screen.getByRole("button", { name: /^Running research activity/ });
  expect(running).toHaveAttribute("aria-expanded", "true");

  await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });

  expect(screen.queryByRole("button", { name: /^Running research activity/ }))
    .not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Research activity/ }))
    .toHaveAttribute("aria-expanded", "false");
});

it("presents research steps as a table whose columns are named for screen readers", () => {
  render(
    <ResearchActivityDisclosure
      activities={[makeActivity({ activityId: "step-1", action: "open", source: "browser", url: "https://example.com/research" })]}
      resolved={false}
    />,
  );

  // The design has no visible header row, so the column meanings have to reach
  // assistive technology some other way.
  expect(screen.getByRole("table", { name: /research steps/i })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Page" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Source" })).toBeInTheDocument();
  expect(
    screen.getByRole("row", { name: "Research activity open completed" }),
  ).toBeInTheDocument();
});

it("opens a visited page at its exact url", async () => {
  const opened = vi.fn();
  vi.stubGlobal("open", opened);
  render(
    <ResearchActivityDisclosure
      activities={[makeActivity({ activityId: "step-1", url: "https://example.com/research" })]}
      resolved={false}
    />,
  );

  await userEvent.setup().click(
    screen.getByRole("button", { name: "Open https://example.com/research" }),
  );

  expect(opened).toHaveBeenCalledWith(
    "https://example.com/research",
    "_blank",
    "noopener,noreferrer",
  );
});

it("treats only a completed page as a visited site", async () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(new Blob(["icon"]), {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:icon"),
    revokeObjectURL: vi.fn(),
  });

  render(
    <ResearchActivityDisclosure
      activities={[
        makeActivity({ activityId: "done", url: "https://opened.example/page" }),
        // Cancelled, but with a URL and no error metadata: still not a page the
        // researcher actually read, so it keeps its status icon.
        makeActivity({ activityId: "stopped", state: "cancelled", url: "https://stopped.example/page" }),
      ]}
      resolved={false}
    />,
  );

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock.mock.calls[0]?.[0]).toContain("/research-activity/favicon");
  expect(fetchMock.mock.calls[0]?.[0]).toContain(
    encodeURIComponent("https://opened.example"),
  );

  // Nor is a cancelled step offered as a page the reader can go and open.
  expect(
    screen.getByRole("button", { name: "Open https://opened.example/page" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open https://stopped.example/page" }),
  ).not.toBeInTheDocument();
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function makeActivity(
  overrides: Partial<ResearchActivity> & { readonly activityId: string },
): ResearchActivity {
  return {
    source: "research-web",
    sessionId: "session-1",
    runId: "run-1",
    assignmentId: "assignment-1",
    agentPath: "agents/web-researcher",
    toolCallId: `call-${overrides.activityId}`,
    action: "acquire",
    kind: "page",
    state: "completed",
    createdAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-16T10:00:01.000Z",
    ...overrides,
  };
}
