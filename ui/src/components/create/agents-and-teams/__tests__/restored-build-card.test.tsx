/**
 * What Create shows when it is reopened over a build that never finished.
 *
 * The page remembers nothing across a reload. Everything the card needs — the
 * plan, the revision that describes it, the build it was admitted for, and the
 * receipt of the attempt that stopped — comes back from the server, so the
 * client module is deliberately not mocked here: only `fetch` is stubbed. A
 * test that handed the hook already-typed objects would stay green against a
 * reader that quietly drops the fields the restore depends on.
 */

import { getConfig, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import AgentsAndTeamsPanel from "@/components/create/agents-and-teams/agents-and-teams-panel";

const ADMITTED_REVISION = `sha256:${"c".repeat(64)}`;

const teamPlan = {
  id: "plan-interrupted",
  kind: "team" as const,
  team: {
    teamId: "contract-review-team",
    description: "Reviews contracts.",
    tags: [],
    existingAgents: [
      { name: "risk-lead", role: "Lead", rationale: "Already available." },
    ],
    newAgents: [{
      name: "risk-spotter",
      role: "Risk reviewer",
      description: "Finds risky clauses.",
      rationale: "Needed.",
    }],
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

/**
 * The interrupted attempt, as the server reconciled it.
 *
 * Its Team shell exists and is named, because retry and discard both need to
 * know which shell it left behind — and it is not published, so the item is
 * interrupted and nothing is selected.
 */
const interruptedJob = {
  jobId: "0000aaaa-0000-4000-8000-00000000000a",
  planId: "plan-interrupted",
  admittedRevision: ADMITTED_REVISION,
  startedAt: "2026-09-13T11:00:00.000Z",
  status: "interrupted",
  items: [{
    plannedResource: { kind: "team", id: "contract-review-team" },
    resource: { kind: "team", id: "contract-review-team" },
    planIndex: 0,
    status: "interrupted",
    error: "Resource build was interrupted by an API restart. Retry the build to continue.",
  }],
  selectedResource: null,
  events: [{
    id: 1,
    type: "team_created",
    plannedResource: { kind: "team", id: "contract-review-team" },
    message: "Created Team shell `contract-review-team`.",
  }],
  error: "Resource build was interrupted by an API restart. Retry the build to continue.",
};

/** An older attempt whose job id sorts after the newer one's. */
const olderJob = {
  ...interruptedJob,
  jobId: "ffffbbbb-0000-4000-8000-00000000000b",
  planId: "plan-older",
  startedAt: "2026-09-13T08:00:00.000Z",
};

/** A skill update of an existing Agent, which a later build tried to apply. */
const skillUpdatePlan = {
  id: "plan-failed",
  kind: "resource_updates" as const,
  operations: [{
    kind: "update_agent_skills" as const,
    target: { kind: "agent" as const, id: "risk-lead" },
    expectedRevision: `sha256:${"d".repeat(64)}`,
    skillUpdates: [{
      action: "create" as const,
      name: "clause-check",
      instruction: "Check each clause for uncapped liability.",
    }],
  }],
};

/**
 * That later attempt, which failed for its own reason. It is newer than the
 * interrupted attempt, so it decides what a reopened Create shows.
 */
const newerFailedJob = {
  jobId: "ffffcccc-0000-4000-8000-00000000000c",
  planId: "plan-failed",
  startedAt: "2026-09-13T12:00:00.000Z",
  status: "failed",
  items: [{
    plannedResource: { kind: "agent", id: "risk-lead" },
    planIndex: 0,
    status: "failed",
    error: "The skill author did not answer.",
  }],
  selectedResource: null,
  events: [],
  error: "The skill author did not answer.",
};

/** Three skills on an existing Agent, the second being authored when the API stopped. */
const interruptedSkillPlan = {
  id: "plan-skills-interrupted",
  kind: "resource_updates" as const,
  operations: [{
    kind: "update_agent_skills" as const,
    target: { kind: "agent" as const, id: "risk-lead" },
    expectedRevision: `sha256:${"f".repeat(64)}`,
    skillUpdates: [
      { action: "create" as const, name: "clause-check", instruction: "Check each clause." },
      { action: "update" as const, name: "cap-check", instruction: "Require a cap." },
      { action: "create" as const, name: "notice-check", instruction: "Check notice windows." },
    ],
  }],
};

/**
 * The attempt as restart reconciliation left it: the first skill staged in the
 * receipt, the second still being authored, the third never started.
 */
const interruptedSkillJob = {
  jobId: "0000dddd-0000-4000-8000-00000000000d",
  planId: "plan-skills-interrupted",
  startedAt: "2026-09-13T13:00:00.000Z",
  status: "interrupted",
  items: [{
    plannedResource: { kind: "agent", id: "risk-lead" },
    planIndex: 0,
    status: "interrupted",
    error: "Resource build was interrupted by an API restart. Retry the build to continue.",
  }],
  selectedResource: null,
  events: [
    { id: 1, type: "build_started", message: "Started." },
    {
      id: 2, type: "resource_update_started", planIndex: 0,
      plannedResource: { kind: "agent", id: "risk-lead" }, message: "Updating Agent `risk-lead`.",
    },
    {
      id: 3, type: "skill_generating", planIndex: 0,
      plannedResource: { kind: "agent", id: "risk-lead" },
      skill: { name: "clause-check", action: "create" }, message: "Authoring skill `clause-check`.",
    },
    {
      id: 4, type: "skill_staged", planIndex: 0,
      plannedResource: { kind: "agent", id: "risk-lead" },
      skill: { name: "clause-check", action: "create" }, message: "Staged skill `clause-check`.",
    },
    {
      id: 5, type: "skill_generating", planIndex: 0,
      plannedResource: { kind: "agent", id: "risk-lead" },
      skill: { name: "cap-check", action: "update" }, message: "Authoring skill `cap-check`.",
    },
    {
      id: 6, type: "build_interrupted",
      message: "Resource build was interrupted by an API restart. Retry the build to continue.",
    },
  ],
  error: "Resource build was interrupted by an API restart. Retry the build to continue.",
};

/** Resolved by the chat stand-in once Create accepts input: restoration is over. */
const restoreSignal = vi.hoisted(() => ({ settle: (): void => {} }));

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON object a request carried, or null when it carried no body. */
function jsonBody(init: RequestInit | undefined): Record<string, unknown> | null {
  if (!init?.body) return null;
  const parsed: unknown = JSON.parse(String(init.body));
  if (!isRecord(parsed)) {
    throw new Error(`Expected a JSON object body, got ${String(init.body)}`);
  }
  return parsed;
}

vi.mock("@/components/create/workflow-generator-chat", () => ({
  default: function Chat(props: {
    additionalTimelineItems?: Array<
      { id: string; occurredAt: string; content: React.ReactNode }
    >;
    inputDisabled?: boolean;
  }) {
    const [mountId] = useState(() => 1);
    if (props.inputDisabled === false) restoreSignal.settle();
    return (
      <div data-testid="resource-chat" data-mount-id={mountId}>
        {props.additionalTimelineItems?.map((item) => (
          <div key={item.id}>{item.content}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/create/agent-architect-panel", () => ({
  default: () => <div>Agent inspector</div>,
}));

vi.mock("@/components/create/team-architect-panel", () => ({
  default: () => <div>Team inspector</div>,
}));

// The composer's model picker, which has nothing to do with restoration.
vi.mock("@/lib/clients/chat-defaults-client", () => ({
  fetchChatDefaults: vi.fn(() =>
    Promise.resolve({ team: { provider: "openai", model: "test-model" } }),
  ),
}));

function stubServer(jobs: unknown[] = [olderJob, interruptedJob]): Recorded[] {
  const calls: Recorded[] = [];
  const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: jsonBody(init),
      });

      if (url.endsWith("/resource-architect/conversation")) return json(null);

      if (method === "GET" && /\/resource-architect\/jobs$/.test(url)) {
        // By default two attempts, with the newer one carrying the id that
        // sorts first.
        return json({ jobs });
      }
      if (url.includes("/plans/plan-interrupted/shape")) {
        return json({
          planId: "plan-interrupted",
          revision: ADMITTED_REVISION,
          shape: teamPlan.team.shape,
          plan: teamPlan,
          admitted: {
            jobId: interruptedJob.jobId,
            revision: ADMITTED_REVISION,
          },
        });
      }
      if (url.includes("/plans/plan-skills-interrupted/shape")) {
        return json({
          planId: "plan-skills-interrupted",
          revision: `sha256:${"a".repeat(64)}`,
          plan: interruptedSkillPlan,
        });
      }
      if (url.includes("/plans/plan-failed/shape")) {
        return json({ planId: "plan-failed", revision: `sha256:${"e".repeat(64)}`, plan: skillUpdatePlan });
      }
      if (url.includes("/resource-architect/metrics")) return json([]);
      return json([]);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("reopening Create over a build that stopped", () => {
  it("restores the card for the attempt that was admitted most recently", async () => {
    stubServer();
    render(<AgentsAndTeamsPanel />);

    const card = await screen.findByLabelText("Team contract-review-team");
    expect(card).toBeInTheDocument();
    // The plan the restored card describes, not the older attempt's.
    expect(within(card).getByText("Reviews contracts.")).toBeInTheDocument();
  });

  it("offers Retry and does not offer to open the unpublished shell", async () => {
    stubServer();
    render(<AgentsAndTeamsPanel />);

    const card = await screen.findByLabelText("Team contract-review-team");
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: "Retry" })).toBeInTheDocument()
    );
    // The shell exists and is named on the receipt, but it was never published.
    expect(
      within(card).queryByRole("button", { name: /^Open / }),
    ).not.toBeInTheDocument();
  });

  it("says the shape is settled instead of offering a change that cannot work", async () => {
    stubServer();
    render(<AgentsAndTeamsPanel />);

    const card = await screen.findByLabelText("Team contract-review-team");
    await waitFor(() =>
      expect(within(card).queryByRole("tablist", { name: "How they work together" })).not
        .toBeInTheDocument()
    );
    // The build this plan was admitted for did not finish, so the way forward
    // is retrying it or starting again — not editing a team that is not there.
    expect(
      within(card).getByText(/that build did not finish/i),
    ).toBeInTheDocument();
    expect(
      within(card).queryByText(/edit the team itself/i),
    ).not.toBeInTheDocument();
  });
});

describe("reopening Create after a newer build failed", () => {
  it("opens clean, neither showing the failure nor bringing back the older interrupted build", async () => {
    stubServer([interruptedJob, newerFailedJob]);
    const restored = new Promise<void>((resolve) => {
      restoreSignal.settle = resolve;
    });

    render(<AgentsAndTeamsPanel />);
    // React defers rendering inside act(), so the signal is awaited outside it.
    await getConfig().asyncWrapper(() => restored);

    expect(screen.queryByLabelText("Team contract-review-team")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Update agent risk-lead")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});

describe("reopening Create over an interrupted skill update", () => {
  it("shows each skill where the build left it, without starting another build", async () => {
    const calls = stubServer([interruptedSkillJob]);

    render(<AgentsAndTeamsPanel />);

    const card = await screen.findByLabelText("Update agent risk-lead");
    await waitFor(() =>
      expect(within(card).getByLabelText("Create skill clause-check staged")).toBeInTheDocument()
    );
    expect(within(card).getByLabelText("Update skill cap-check interrupted")).toBeInTheDocument();
    expect(within(card).getByLabelText("Create skill notice-check planned")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Reading the statuses back asked nothing of the build routes.
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});
