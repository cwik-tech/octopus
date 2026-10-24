import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { McpInteractionCard } from "@/components/run/mcp/mcp-interaction-card";
import { McpInteractionList } from "@/components/run/mcp/mcp-interaction-list";
import {
  type McpApprovalInteraction,
  type McpFormElicitationInteraction,
  type McpInteractionsClient,
  type McpUrlElicitationInteraction,
} from "@/lib/clients/mcp-interactions-client";

it("renders a redacted approval and submits each approval scope", async () => {
  const interaction = approval();
  const onRespond = vi.fn().mockResolvedValue({
    ...interaction,
    status: "approved-run",
  });
  const user = userEvent.setup();
  render(<McpInteractionCard interaction={interaction} onRespond={onRespond} />);

  expect(screen.getByText(/mcp__documents__search/)).toBeInTheDocument();
  expect(screen.getByText("query")).toBeInTheDocument();
  expect(screen.getByText("limit")).toBeInTheDocument();
  expect(screen.queryByText("private search value")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Allow for run" }));
  expect(onRespond).toHaveBeenCalledWith({
    kind: "approval",
    decision: "approve",
    scope: "run",
  });
});

it("keeps a failed approval actionable so the user can retry", async () => {
  const interaction = approval();
  const onRespond = vi.fn()
    .mockRejectedValueOnce(new Error("Request is still pending"))
    .mockResolvedValueOnce({ ...interaction, status: "approved-once" });
  const user = userEvent.setup();
  render(<McpInteractionCard interaction={interaction} onRespond={onRespond} />);

  await user.click(screen.getByRole("button", { name: "Allow once" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Request is still pending You can retry.",
  );
  expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled();

  await user.click(screen.getByRole("button", { name: "Allow once" }));
  expect(onRespond).toHaveBeenCalledTimes(2);
});

it("renders a controlled primitive form, validates arrays, and sends values ephemerally", async () => {
  const interaction = formElicitation();
  const onRespond = vi.fn().mockResolvedValue({
    ...interaction,
    status: "accepted",
  });
  const user = userEvent.setup();
  const { container } = render(
    <McpInteractionCard interaction={interaction} onRespond={onRespond} />,
  );

  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(screen.getByLabelText("Search query *")).toHaveValue("");
  expect(screen.getByLabelText("Result type *")).toHaveValue("article");
  expect(screen.getByLabelText("Maximum results *")).toHaveValue(10);
  expect(screen.getByLabelText("Include drafts *")).not.toBeChecked();

  await user.type(screen.getByLabelText("Search query *"), "quarterly revenue");
  await user.selectOptions(screen.getByLabelText("Result type *"), "dataset");
  await user.clear(screen.getByLabelText("Maximum results *"));
  await user.type(screen.getByLabelText("Maximum results *"), "25");
  await user.click(screen.getByLabelText("Include drafts *"));
  await user.click(screen.getByRole("button", { name: "Continue" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Regions requires at least 1 selection. You can retry.",
  );
  expect(onRespond).not.toHaveBeenCalled();

  await user.click(screen.getByLabelText("North America"));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => {
    expect(onRespond).toHaveBeenCalledWith({
      kind: "elicitation",
      action: "accept",
      values: {
        query: "quarterly revenue",
        resultType: "dataset",
        limit: 25,
        includeDrafts: true,
        regions: ["na"],
      },
    });
  });
});

it("opens only safe URL elicitations and exposes continue, decline, and cancel", async () => {
  const interaction = urlElicitation();
  const onRespond = vi.fn().mockResolvedValue({
    ...interaction,
    status: "accepted",
  });
  const user = userEvent.setup();
  const { rerender } = render(
    <McpInteractionCard interaction={interaction} onRespond={onRespond} />,
  );

  const link = screen.getByRole("link", { name: /Open request in browser/ });
  expect(link).toHaveAttribute("href", "https://example.com/authorize?id=one");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

  await user.click(screen.getByRole("button", { name: "Decline" }));
  expect(onRespond).toHaveBeenCalledWith({
    kind: "elicitation",
    action: "decline",
  });

  rerender(
    <McpInteractionCard
      interaction={{ ...interaction, url: "javascript:alert(1)" }}
      onRespond={onRespond}
    />,
  );
  expect(screen.queryByRole("link", { name: /Open request in browser/ })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("unsafe link");
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

it("polls the selected session and retries a failed initial request", async () => {
  const interaction = approval();
  const client: McpInteractionsClient = {
    list: vi.fn()
      .mockRejectedValueOnce(new Error("Interaction service unavailable"))
      .mockResolvedValue({ interactions: [interaction], truncated: true }),
    respond: vi.fn().mockResolvedValue({
      ...interaction,
      status: "denied",
    }),
  };
  const user = userEvent.setup();
  render(
    <McpInteractionList
      sessionId="session-1"
      client={client}
      pollIntervalMs={60_000}
    />,
  );

  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Interaction service unavailable",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findByText("Approval required")).toBeInTheDocument();
  expect(screen.getByText(/More MCP requests are waiting/)).toBeInTheDocument();
  expect(client.list).toHaveBeenLastCalledWith("session-1", expect.any(AbortSignal));

  await user.click(screen.getByRole("button", { name: "Deny" }));
  expect(client.respond).toHaveBeenCalledWith(
    "session-1",
    "interaction-1",
    { kind: "approval", decision: "deny" },
  );
  expect(await screen.findByText("Denied.")).toBeInTheDocument();
});

function approval(
  overrides: Partial<McpApprovalInteraction> = {},
): McpApprovalInteraction {
  return {
    kind: "approval",
    interactionId: "interaction-1",
    sessionId: "session-1",
    runId: "run-1",
    assignmentId: "assignment-1",
    agentPath: "agents/researcher.md",
    serverId: "documents",
    toolCallId: "tool-call-1",
    namespacedToolName: "mcp__documents__search",
    toolRisk: "mutating",
    argumentNames: ["query", "limit"],
    status: "pending",
    createdAt: "2026-07-12T12:00:00.000Z",
    expiresAt: "2026-07-12T12:05:00.000Z",
    ...overrides,
  };
}

function formElicitation(): McpFormElicitationInteraction {
  return {
    kind: "elicitation",
    mode: "form",
    interactionId: "form-1",
    sessionId: "session-1",
    runId: "run-1",
    assignmentId: "assignment-1",
    agentPath: "agents/researcher.md",
    serverId: "documents",
    toolCallId: "tool-call-2",
    namespacedToolName: "mcp__documents__search",
    message: "Configure the search request.",
    status: "pending",
    createdAt: "2026-07-12T12:00:00.000Z",
    expiresAt: "2026-07-12T12:05:00.000Z",
    schema: {
      type: "object",
      required: ["query", "resultType", "limit", "includeDrafts", "regions"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          title: "Search query",
          minLength: 2,
          maxLength: 100,
        },
        resultType: {
          type: "string",
          title: "Result type",
          oneOf: [
            { const: "article", title: "Article" },
            { const: "dataset", title: "Dataset" },
          ],
          default: "article",
        },
        limit: {
          type: "integer",
          title: "Maximum results",
          minimum: 1,
          maximum: 100,
          default: 10,
        },
        includeDrafts: {
          type: "boolean",
          title: "Include drafts",
          default: false,
        },
        regions: {
          type: "array",
          title: "Regions",
          minItems: 1,
          maxItems: 2,
          items: {
            anyOf: [
              { const: "na", title: "North America" },
              { const: "eu", title: "Europe" },
            ],
          },
        },
      },
    },
  };
}

function urlElicitation(): McpUrlElicitationInteraction {
  return {
    kind: "elicitation",
    mode: "url",
    interactionId: "url-1",
    sessionId: "session-1",
    runId: "run-1",
    assignmentId: "assignment-1",
    agentPath: "agents/researcher.md",
    serverId: "documents",
    toolCallId: "tool-call-3",
    namespacedToolName: "mcp__documents__authorize",
    message: "Authorize access in your browser.",
    status: "pending",
    createdAt: "2026-07-12T12:00:00.000Z",
    expiresAt: "2026-07-12T12:05:00.000Z",
    url: "https://example.com/authorize?id=one",
    elicitationId: "authorize-1",
  };
}
