/**
 * The failed revision read, as the panel actually renders it.
 *
 * The hook records the failure and the card knows how to show it, but the card
 * is built inside a memo. If that memo does not depend on the read's state it
 * keeps handing back the card it built before, and the message and the button
 * never appear however correct both halves are on their own. Only a test that
 * crosses that join can prove it, so this one renders the real panel, the real
 * chat, the real card and the real client, and stubs nothing but `fetch`.
 *
 * The failure is delivered late on purpose. A rejection that lands in the same
 * render as the plan is applied together with it and proves nothing about the
 * memo; over a network it never does.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import AgentsAndTeamsPanel from "@/components/create/agents-and-teams/agents-and-teams-panel";
import { ProviderCatalogProvider } from "@/contexts/provider-catalog-context";

const REVISION = `sha256:${"d".repeat(64)}`;
const MODEL = { provider: "openai", model: "test-model" };

const teamPlan = {
  id: "plan-1",
  kind: "team" as const,
  team: {
    teamId: "contract-review",
    description: "Reviews contracts.",
    tags: [],
    existingAgents: [
      { name: "risk-lead", role: "Lead", rationale: "Already available." },
      { name: "risk-spotter", role: "Spotter", rationale: "Already available." },
    ],
    newAgents: [],
    questionsResolved: [],
    shape: {
      kind: "discussion" as const,
      rationale: "They disagree usefully.",
      depth: "standard" as const,
      coordinator: "risk-lead",
      participants: ["risk-spotter"],
    },
  },
};

function meta() {
  return {
    provider: MODEL.provider,
    model: MODEL.model,
    fallback: false,
    reasoning: "low",
    timing: {
      contextAssemblyMs: 0,
      providerDurationMs: 0,
      processSpawnMs: null,
      firstProviderEventMs: null,
      firstTextMs: null,
      parseDurationMs: 0,
      repairOccurred: false,
      repairDurationMs: 0,
      totalDurationMs: 0,
      context: {
        instructionsChars: 0,
        operationChars: 0,
        uploadedDocumentPolicyChars: 0,
        visualizationPolicyChars: 0,
        teamLibraryChars: 0,
        agentLibraryChars: 0,
        totalChars: 0,
        historyChars: 0,
      },
    },
  };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The whole app-facing surface this panel touches, answered over `fetch`.
 *
 * `holdFirstShapeRead` decides how the first revision read behaves: a promise
 * the test settles itself, so the failure can be made to arrive after the card
 * is already on screen.
 */
function stubServer(options: { firstShapeRead?: Promise<never> } = {}): {
  shapeReads: () => number;
  proposals: () => number;
} {
  let shapeReads = 0;
  let proposals = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const path = new URL(url, "http://localhost").pathname;

      if (path.endsWith("/settings/model-catalog")) {
        return json({
          catalog: [{
            provider: MODEL.provider,
            label: "OpenAI",
            models: [{ id: MODEL.model, label: "Test model" }],
          }],
          defaultModel: MODEL,
          defaultModelState: { status: "set", selection: MODEL },
        });
      }
      if (path.endsWith("/create/chat-defaults")) {
        return json({ team: MODEL });
      }
      if (path.endsWith("/create/resource-architect/turn")) {
        // The text-stream subscription shares this path and is answered the
        // way a server with no stream answers it.
        if (method === "GET") return new Response(null, { status: 404 });
        proposals += 1;
        return json({
          jobId: `job-${proposals}`,
          operation: "proposal",
          message: "Proposal ready.",
          warnings: [],
          outcome: teamPlan,
          meta: meta(),
        });
      }
      if (/\/plans\/[^/]+\/shape$/u.test(path)) {
        shapeReads += 1;
        if (shapeReads === 1 && options.firstShapeRead) {
          // Settled by the test, long after the card has rendered.
          return options.firstShapeRead;
        }
        return json({
          planId: "plan-1",
          revision: REVISION,
          plan: teamPlan,
          shape: teamPlan.team.shape,
        });
      }
      if (path.endsWith("/create/resource-architect/metrics")) {
        return json({ metrics: [] });
      }
      if (path.endsWith("/create/resource-architect/jobs")) {
        return json({ jobs: [] });
      }
      // The composer lists what has been uploaded against this draft. An
      // answer without the key it reads crashes the chat before it renders.
      if (/\/create\/team-files\/[^/]+\/files$/u.test(path)) {
        return json({ files: [] });
      }
      return json([]);
    }),
  );
  return { shapeReads: () => shapeReads, proposals: () => proposals };
}

function renderPanel() {
  render(
    <ProviderCatalogProvider>
      <AgentsAndTeamsPanel />
    </ProviderCatalogProvider>,
  );
}

async function askForATeam(user: ReturnType<typeof userEvent.setup>) {
  const composer = await screen.findByPlaceholderText(
    "Describe the Agents or Team you need…",
  );
  await waitFor(() => expect(composer).toBeEnabled());
  await user.type(composer, "Build a contract review team");
  await user.click(screen.getByRole("button", { name: "Submit" }));
}

afterEach(() => vi.unstubAllGlobals());

describe("a plan whose revision could not be read, in the panel", () => {
  it("shows the failure, and the same card becomes usable when the read is retried", async () => {
    const user = userEvent.setup();
    let failFirstRead = (): void => {};
    const firstShapeRead = new Promise<never>((_resolve, reject) => {
      failFirstRead = () => reject(new Error("the server did not answer"));
    });
    firstShapeRead.catch(() => {});
    const counts = stubServer({ firstShapeRead });

    renderPanel();
    await askForATeam(user);

    // The card is on screen while its revision is still being read, and says
    // nothing about a failure that has not happened.
    await waitFor(() =>
      expect(screen.getByLabelText("Team contract-review")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();

    failFirstRead();

    await waitFor(() =>
      expect(
        screen.getByText(/could not be read, so how this team works together cannot be changed yet/i),
      ).toBeInTheDocument(),
    );
    // Nothing can be built from a plan whose revision is unknown, and there is
    // nothing to change it with either until it can be read.
    expect(screen.getByRole("button", { name: /^Create$/ })).toBeDisabled();
    expect(screen.queryByRole("tablist", { name: "How they work together" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    // The message goes and the controls come back, without the Architect being
    // asked for anything: the same proposal is what became buildable.
    await waitFor(() =>
      expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /^Create$/ })).toBeEnabled();
    expect(screen.getByRole("tablist", { name: "How they work together" })).toBeInTheDocument();
    expect(counts.proposals()).toBe(1);
    expect(counts.shapeReads()).toBe(2);
  });

  it("says nothing about a read that has not failed", async () => {
    const user = userEvent.setup();
    stubServer();

    renderPanel();
    await askForATeam(user);

    await waitFor(() =>
      expect(screen.getByRole("tablist", { name: "How they work together" })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Try again|Trying again/ }),
    ).not.toBeInTheDocument();
  });
});
