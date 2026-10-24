import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { ProjectFileCatalog } from "@/components/library/project-file-catalog";
import type { WorkspaceProjectCatalogFile } from "@contracts/projects";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.restoreAllMocks();
});

test("file catalog loads the root first and a session branch only when expanded", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/projects/${PROJECT_ID}/catalog`)) {
      return jsonResponse({
        version: 1,
        projectId: PROJECT_ID,
        sharedInputs: [catalogFile("shared.pdf", "project_file", "browser")],
        sessions: [
          {
            id: SESSION_ID,
            title: "Research",
            updatedAt: "2026-08-04T12:00:00.000Z",
          },
        ],
      });
    }
    if (url.endsWith(`/projects/${PROJECT_ID}/catalog/sessions/${SESSION_ID}`)) {
      return jsonResponse({
        version: 1,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        inputs: [],
        deliveries: [catalogFile("report.md", "run_artifact", "artifact")],
        artifacts: [],
        evidence: [catalogFile("sources.json", "run_artifact", "artifact")],
      });
    }
    if (url.includes("/runs/run-1/assignments/")) {
      return new Response("# Previewed report", { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();

  render(<ProjectFileCatalog projectId={PROJECT_ID} />);

  expect(await screen.findByText("shared.pdf")).toBeInTheDocument();
  expect(screen.queryByText("report.md")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Expand Research" }));
  expect(await screen.findByText("report.md")).toBeInTheDocument();
  expect(screen.getByText("sources.json")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await user.click(screen.getByText("report.md"));
  expect(
    await screen.findByRole("heading", { name: "Previewed report" }),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/runs/run-1/assignments/report.md",
    );
  });
});

test("file catalog preserves an expanded session and preview across a same-project root refresh", async () => {
  const initialRoot = {
    version: 1 as const,
    projectId: PROJECT_ID,
    sharedInputs: [catalogFile("shared.pdf", "project_file", "browser")],
    sessions: [
      {
        id: SESSION_ID,
        title: "Research",
        updatedAt: "2026-08-04T12:00:00.000Z",
      },
    ],
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/projects/${PROJECT_ID}/catalog/sessions/${SESSION_ID}`)) {
      return jsonResponse({
        version: 1,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        inputs: [],
        deliveries: [catalogFile("report.md", "run_artifact", "artifact")],
        artifacts: [],
        evidence: [],
      });
    }
    if (url.endsWith("/runs/run-1/assignments/report.md")) {
      return new Response("# Previewed report", { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  const { rerender } = render(
    <ProjectFileCatalog projectId={PROJECT_ID} initialRoot={initialRoot} />,
  );

  await user.click(screen.getByRole("button", { name: "Expand Research" }));
  await user.click(await screen.findByText("report.md"));
  expect(
    await screen.findByRole("heading", { name: "Previewed report" }),
  ).toBeInTheDocument();

  rerender(
    <ProjectFileCatalog
      projectId={PROJECT_ID}
      initialRoot={{
        ...initialRoot,
        sharedInputs: [
          ...initialRoot.sharedInputs,
          catalogFile("new-source.md", "project_file", "browser"),
        ],
      }}
    />,
  );

  const catalog = screen.getByRole("region", { name: "File catalog" });
  expect(within(catalog).getByRole("button", { name: "Collapse Research" })).toBeInTheDocument();
  expect(within(catalog).getByText("report.md")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Previewed report" })).toBeInTheDocument();
  expect(screen.getByText("new-source.md")).toBeInTheDocument();
  expect(
    fetchMock.mock.calls.filter(([input]) =>
      String(input).includes(`/catalog/sessions/${SESSION_ID}`),
    ),
  ).toHaveLength(1);
});

test("standalone file catalog reloads its root when refreshKey changes", async () => {
  let rootRead = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith(`/projects/${PROJECT_ID}/catalog`)) {
      throw new Error(`Unexpected request: ${url}`);
    }
    rootRead += 1;
    return jsonResponse({
      version: 1,
      projectId: PROJECT_ID,
      sharedInputs: [
        catalogFile(
          rootRead === 1 ? "first-source.md" : "refreshed-source.md",
          "project_file",
          "browser",
        ),
      ],
      sessions: [],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { rerender } = render(
    <ProjectFileCatalog projectId={PROJECT_ID} refreshKey={0} />,
  );
  expect(await screen.findByText("first-source.md")).toBeInTheDocument();

  rerender(<ProjectFileCatalog projectId={PROJECT_ID} refreshKey={1} />);

  expect(await screen.findByText("refreshed-source.md")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

function catalogFile(
  name: string,
  kind: "project_file" | "run_artifact",
  preview: "artifact" | "browser",
): WorkspaceProjectCatalogFile {
  const resource = kind === "project_file"
    ? {
        kind,
        projectId: PROJECT_ID,
        filename: name,
        resourcePath: `/projects/${PROJECT_ID}/files/${name}`,
      }
    : {
        kind,
        runId: "run-1",
        artifactPath: name,
        resourcePath: `/runs/run-1/assignments/${name}`,
      };
  return {
    id: `${kind}:${name}`,
    name,
    category: kind === "project_file" ? "shared_input" : "delivery",
    contentType: name.endsWith(".pdf") ? "application/pdf" : "text/markdown",
    capabilities: { preview, download: true, delete: false },
    resource,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
