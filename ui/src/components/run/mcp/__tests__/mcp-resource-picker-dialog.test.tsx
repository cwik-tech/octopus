import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { McpResourcePickerDialog } from "@/components/run/mcp/mcp-resource-picker-dialog";
import type {
  McpResourceDescriptor,
  McpResourceImportResult,
  McpResourcesClient,
} from "@/lib/clients/mcp-resources-client";

it("filters real resources, paginates, blocks unsupported types, and imports", async () => {
  const alpha = resource({ id: "alpha-1", name: "Alpha notes" });
  const beta = resource({
    id: "beta-1",
    serverId: "beta",
    serverName: "Beta server",
    name: "Beta report",
    uri: "docs://beta/report",
  });
  const blocked = resource({
    id: "blocked-1",
    name: "Blocked script",
    disposition: "blocked",
    mimeType: "application/javascript",
  });
  const betaNext = resource({
    id: "beta-2",
    serverId: "beta",
    serverName: "Beta server",
    name: "Beta appendix",
    uri: "docs://beta/appendix",
  });
  const importResult = importedResult(beta);
  const client: McpResourcesClient = {
    listServers: vi.fn().mockResolvedValue([
      { id: "alpha", name: "Alpha server" },
      { id: "beta", name: "Beta server" },
    ]),
    listResources: vi.fn<McpResourcesClient["listResources"]>(async (_sessionId, options) => {
      if (options?.serverId === "beta" && options.cursor === "beta-next") {
        return { resources: [betaNext] };
      }
      if (options?.serverId === "beta") {
        return { resources: [beta], nextCursor: "beta-next" };
      }
      return { resources: [alpha, blocked] };
    }),
    listImports: vi.fn(),
    importResource: vi.fn(async () => importResult),
  };
  const onImported = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();

  render(
    <McpResourcePickerDialog
      open
      sessionId="session-1"
      client={client}
      onImported={onImported}
      onOpenChange={onOpenChange}
    />,
  );

  expect(await screen.findByText("Alpha notes")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Import Blocked script" })).toBeDisabled();
  expect(screen.getByText(/Blocked resource type/)).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText("MCP server"), "beta");
  await waitFor(() => {
    expect(client.listResources).toHaveBeenCalledWith("session-1", expect.objectContaining({
      serverId: "beta",
      limit: 50,
    }));
  });
  expect(await screen.findByText("Beta report")).toBeInTheDocument();
  expect(screen.queryByText("Alpha notes")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Beta appendix")).toBeInTheDocument();
  expect(client.listResources).toHaveBeenCalledWith("session-1", expect.objectContaining({
    serverId: "beta",
    cursor: "beta-next",
  }));

  await user.click(screen.getByRole("button", { name: "Import Beta report" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Beta report added as 1 session file.",
  );
  expect(client.importResource).toHaveBeenCalledWith("session-1", {
    serverId: "beta",
    uri: "docs://beta/report",
  }, expect.anything());
  expect(onImported).toHaveBeenCalledWith(importResult);

  const closeButton = screen.getByRole("button", {
    name: "Close MCP resource picker",
  });
  closeButton.focus();
  await user.keyboard("{Enter}");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("shows loading failures, retries, and reports an empty catalog", async () => {
  const client: McpResourcesClient = {
    listServers: vi.fn().mockResolvedValue([]),
    listResources: vi.fn()
      .mockRejectedValueOnce(new Error("Catalog unavailable"))
      .mockResolvedValueOnce({ resources: [] }),
    listImports: vi.fn(),
    importResource: vi.fn(),
  };
  const user = userEvent.setup();

  render(
    <McpResourcePickerDialog
      open
      sessionId="session-1"
      client={client}
      onOpenChange={vi.fn()}
    />,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(/No importable MCP resources/)).toBeInTheDocument();
  expect(client.listResources).toHaveBeenCalledTimes(2);
});

it("imports unknown multi-content resources again as fresh snapshots", async () => {
  const unknown = resource({
    id: "unknown-1",
    name: "Untyped bundle",
    uri: "docs://alpha/untyped",
    mimeType: undefined,
    disposition: "unknown",
  });
  const result = importedResult(unknown, 2);
  const client: McpResourcesClient = {
    listServers: vi.fn().mockResolvedValue([
      { id: "alpha", name: "Alpha server" },
    ]),
    listResources: vi.fn().mockResolvedValue({ resources: [unknown] }),
    listImports: vi.fn(),
    importResource: vi.fn().mockResolvedValue(result),
  };
  const onImported = vi.fn();
  const user = userEvent.setup();
  render(
    <McpResourcePickerDialog
      open
      sessionId="session-1"
      client={client}
      onImported={onImported}
      onOpenChange={vi.fn()}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Import Untyped bundle" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Untyped bundle added as 2 session files.",
  );
  expect(result.import.contents).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "Import Untyped bundle" }));
  await waitFor(() => expect(client.importResource).toHaveBeenCalledTimes(2));
  expect(onImported).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Import Untyped bundle" })).toHaveTextContent(
    "Import again",
  );
});

function resource(
  overrides: Partial<McpResourceDescriptor> = {},
): McpResourceDescriptor {
  return {
    id: "alpha-1",
    serverId: "alpha",
    serverName: "Alpha server",
    uri: "docs://alpha/notes",
    name: "Alpha notes",
    mimeType: "text/plain",
    disposition: "text",
    ...overrides,
  };
}

function importedResult(
  resourceValue: McpResourceDescriptor,
  fileCount = 1,
): McpResourceImportResult {
  const capturedAt = "2026-07-12T12:00:00.000Z";
  return {
    files: Array.from({ length: fileCount }, (_, index) => ({
      name: `resource-${index + 1}.txt`,
      size: 8,
      uploadedAt: capturedAt,
      parseStatus: "pending" as const,
    })),
    import: {
      version: 1,
      snapshotId: "snapshot-1",
      sessionId: "session-1",
      capturedAt,
      server: { id: resourceValue.serverId, name: resourceValue.serverName },
      resource: {
        id: resourceValue.id,
        uri: resourceValue.uri,
        name: resourceValue.name,
      },
      totalBytes: 8 * fileCount,
      contents: Array.from({ length: fileCount }, (_, index) => ({
        id: `content-${index + 1}`,
        sourceUri: `${resourceValue.uri}#${index + 1}`,
        mimeType: "text/plain",
        kind: "text" as const,
        byteLength: 8,
        sha256: "b".repeat(64),
        storedPath: `contents/0${index}-resource.txt`,
        materializedInputFilename: `resource-${index + 1}.txt`,
      })),
    },
  };
}
