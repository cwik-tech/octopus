import { afterEach, expect, test, vi } from "vitest";

import { postSessionMessage } from "@/lib/clients/session-client";
import type { ChatMessage, RunPlan, SessionTask } from "@/lib/models/session-model";
import { isPlanBearingDispatch, isTeamDispatch } from "@contracts/sessions";

type FetchMock = (input: string, init: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.restoreAllMocks();
});

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    role: "assistant",
    text: "Here you go",
    createdAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

const USER_MESSAGE = message({ id: "turn-1:user", role: "user", text: "Hi" });

const READY_PLAN: RunPlan = {
  id: "run-plan-1",
  goal: "Write a brief",
  summary: "Ready",
  status: "ready",
  requiredInputs: [],
  actions: [],
  warnings: [],
  createdAt: "2026-08-28T12:00:00.000Z",
};

const TEAM_TASK: SessionTask = {
  id: "task-1",
  sessionId: "session-1",
  runId: "run-1",
  workflowId: "team-chat-board-1",
  targetKind: "team-chat",
  teamId: "problem-thinking-board",
  brief: "Hi",
  status: "queued",
  createdAt: "2026-08-28T12:00:00.000Z",
  cwd: "/tmp/run-1",
};

const COORDINATOR_META = { model: "gpt-5", fallback: false };

function respondWith(body: unknown, status = 201): FetchMock {
  return async () =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
}

test("postSessionMessage reads a Coordinator dispatch whole", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith({
        dispatch: { kind: "coordinator" },
        user: USER_MESSAGE,
        messages: [message()],
        plan: READY_PLAN,
        meta: COORDINATOR_META,
        replayed: false,
      }),
    ),
  );

  const result = await postSessionMessage("session-1", "Hi");

  expect(result.dispatch).toEqual({ kind: "coordinator" });
  expect(result.replayed).toBe(false);
  expect(result.messages).toHaveLength(1);
  if (!isPlanBearingDispatch(result)) throw new Error("wrong branch");
  expect(result.plan.id).toBe("run-plan-1");
});

test("postSessionMessage cancels through the caller's signal and keeps it out of the body", async () => {
  const fetchMock = vi.fn<FetchMock>(
    respondWith({
      dispatch: { kind: "coordinator" },
      user: USER_MESSAGE,
      messages: [message()],
      plan: READY_PLAN,
      meta: COORDINATOR_META,
      replayed: false,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const stop = new AbortController();

  await postSessionMessage("session-1", "Hi", {
    turnId: "turn-1",
    signal: stop.signal,
  });

  const init = fetchMock.mock.calls[0]![1];
  expect(init.signal).toBe(stop.signal);
  expect(JSON.parse(init.body as string)).toEqual({
    text: "Hi",
    turnId: "turn-1",
  });
});

test("postSessionMessage carries the selected Workflow on a Coordinator dispatch", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith({
        dispatch: { kind: "coordinator", selectedWorkflowId: "deep-research-report" },
        user: USER_MESSAGE,
        messages: [message()],
        plan: READY_PLAN,
        meta: COORDINATOR_META,
        replayed: false,
      }),
    ),
  );

  const result = await postSessionMessage("session-1", "Hi");

  expect(result.dispatch).toEqual({
    kind: "coordinator",
    selectedWorkflowId: "deep-research-report",
  });
});

test("postSessionMessage reads an Agents dispatch with its per-reply metadata", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith({
        dispatch: { kind: "agents", agentNames: ["analyst"] },
        user: USER_MESSAGE,
        messages: [message({ id: "analyst:0" })],
        meta: {
          replies: [
            {
              speakerId: "analyst",
              speakerName: "Analyst",
              model: "gpt-5",
              fallback: false,
            },
          ],
        },
        replayed: false,
      }),
    ),
  );

  const result = await postSessionMessage("session-1", "Hi");

  if (isPlanBearingDispatch(result) || isTeamDispatch(result)) {
    throw new Error("wrong branch");
  }
  expect(result.dispatch.agentNames).toEqual(["analyst"]);
  expect(result.meta.replies[0]?.speakerName).toBe("Analyst");
});

test("postSessionMessage reads a Team dispatch with its task", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith({
        dispatch: { kind: "team", teamId: "problem-thinking-board" },
        user: USER_MESSAGE,
        messages: [USER_MESSAGE],
        plan: READY_PLAN,
        task: TEAM_TASK,
        replayed: false,
      }),
    ),
  );

  const result = await postSessionMessage("session-1", "Hi");

  if (!isTeamDispatch(result)) throw new Error("wrong branch");
  expect(result.task.id).toBe("task-1");
  expect(result.dispatch.teamId).toBe("problem-thinking-board");
});

test("postSessionMessage reports a replay without needing the status code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith(
        {
          dispatch: { kind: "coordinator" },
          user: USER_MESSAGE,
          messages: [message()],
          plan: READY_PLAN,
          meta: COORDINATOR_META,
          replayed: true,
        },
        200,
      ),
    ),
  );

  const result = await postSessionMessage("session-1", "Hi");

  expect(result.replayed).toBe(true);
});

test("postSessionMessage refuses a Coordinator dispatch missing its plan", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith({
        dispatch: { kind: "coordinator" },
        user: USER_MESSAGE,
        messages: [message()],
        meta: COORDINATOR_META,
        replayed: false,
      }),
    ),
  );

  await expect(postSessionMessage("session-1", "Hi")).rejects.toThrow(
    /Invalid API response/,
  );
});

test("postSessionMessage refuses a Team dispatch missing its task", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith({
        dispatch: { kind: "team", teamId: "problem-thinking-board" },
        user: USER_MESSAGE,
        messages: [USER_MESSAGE],
        plan: READY_PLAN,
        replayed: false,
      }),
    ),
  );

  await expect(postSessionMessage("session-1", "Hi")).rejects.toThrow(
    /Invalid API response/,
  );
});

test("postSessionMessage refuses an Agents dispatch missing its metadata", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith({
        dispatch: { kind: "agents", agentNames: ["analyst"] },
        user: USER_MESSAGE,
        messages: [message({ id: "analyst:0" })],
        replayed: false,
      }),
    ),
  );

  await expect(postSessionMessage("session-1", "Hi")).rejects.toThrow(
    /Invalid API response/,
  );
});

test("postSessionMessage refuses an unknown dispatch kind", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith({
        dispatch: { kind: "everyone" },
        user: USER_MESSAGE,
        messages: [message()],
        plan: READY_PLAN,
        meta: COORDINATOR_META,
        replayed: false,
      }),
    ),
  );

  await expect(postSessionMessage("session-1", "Hi")).rejects.toThrow(
    /Invalid API response/,
  );
});

test("postSessionMessage refuses a response that never says whether it replayed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(
      respondWith({
        dispatch: { kind: "coordinator" },
        user: USER_MESSAGE,
        messages: [message()],
        plan: READY_PLAN,
        meta: COORDINATOR_META,
      }),
    ),
  );

  await expect(postSessionMessage("session-1", "Hi")).rejects.toThrow(
    /Invalid API response/,
  );
});

test("postSessionMessage sends the explicit target in its JSON body", async () => {
  const fetchMock = vi.fn<FetchMock>(
    respondWith({
      dispatch: { kind: "agents", agentNames: ["analyst"] },
      user: USER_MESSAGE,
      messages: [message({ id: "analyst:0" })],
      meta: { replies: [] },
      replayed: false,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await postSessionMessage("session-1", "Hi", {
    target: { kind: "agents", agentNames: ["analyst"] },
    turnId: "2f6a1d8e-0000-4000-8000-000000000001",
  });

  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toContain("/sessions/session-1/messages");
  expect(JSON.parse(String(init.body))).toEqual({
    text: "Hi",
    target: { kind: "agents", agentNames: ["analyst"] },
    turnId: "2f6a1d8e-0000-4000-8000-000000000001",
  });
});
