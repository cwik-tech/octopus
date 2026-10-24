import { afterEach, expect, test, vi } from "vitest";

import {
  CREATE_SESSION_TIMEOUT_MS,
  cancelSessionTask,
  createSession,
  deleteSessionFile,
  deleteWorkflow,
  deleteSession,
  fetchSession,
  generateSessionResearchPlan,
  approveSessionResearchPlan,
  getSessionRunPlan,
  getWorkflowStages,
  getWorkflowYaml,
  listChatMessages,
  listSessionFiles,
  listSessions,
  listSessionTasks,
  listWorkflows,
  openSessionResearchPlanAttemptStream,
  postAgentChatMessage,
  postChatMessage,
  resumeSessionTask,
  selectSessionWorkflow,
  startSessionTask,
  updateWorkflowYaml,
  updateSessionTitle,
  uploadSessionFile,
  SessionTaskStartError,
} from "@/lib/clients/session-client";

// The session-client always calls fetch with (url, init) for the requests these
// tests inspect. Typing the mock this way makes `.mock.calls[n]` a typed
// [url, init] tuple so assertions on call[0]/call[1] type-check.
type FetchMock = (input: string, init: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  listSessions                                                       */
/* ------------------------------------------------------------------ */

test("listSessions returns sessions from the API", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          sessions: [
            {
              id: "session-1",
              title: "First session",
              status: "active" as const,
              activityType: "chat" as const,
              createdAt: "2026-05-01T12:00:00.000Z",
              updatedAt: "2026-05-01T12:01:00.000Z",
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await listSessions();

  expect(result).toEqual([
    {
      id: "session-1",
      title: "First session",
      status: "active",
      activityType: "chat",
      createdAt: "2026-05-01T12:00:00.000Z",
      updatedAt: "2026-05-01T12:01:00.000Z",
    },
  ]);
  expect(fetchMock).toHaveBeenCalledWith("/api/sessions");
});

/* ------------------------------------------------------------------ */
/*  createSession                                                      */
/* ------------------------------------------------------------------ */

test("createSession without title sends an empty body", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          id: "new-session",
          title: "",
          status: "idle" as const,
          activityType: "chat" as const,
          createdAt: "2026-05-01T12:00:00.000Z",
          updatedAt: "2026-05-01T12:00:00.000Z",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await createSession({});

  expect(result.id).toBe("new-session");
  const call = fetchMock.mock.calls[0]!;
  expect(call[0]).toBe("/api/sessions");
  expect(JSON.parse(call[1].body as string)).toEqual({});
  expect(call[1].method).toBe("POST");
  expect(call[1].headers).toMatchObject({ "content-type": "application/json" });
});

test("createSession trims whitespace from the title", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          id: "new-session",
          title: "Trimmed Title",
          status: "idle" as const,
          activityType: "chat" as const,
          createdAt: "2026-05-01T12:00:00.000Z",
          updatedAt: "2026-05-01T12:00:00.000Z",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await createSession({ title: "  Trimmed Title  " });

  const body: unknown = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
  expect(body).toHaveProperty("title", "Trimmed Title");
});

test("createSession includes projectId for Library-owned sessions", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          id: "new-session",
          projectId: "11111111-1111-4111-8111-111111111111",
          title: "Project chat",
          status: "idle" as const,
          activityType: "chat" as const,
          createdAt: "2026-05-01T12:00:00.000Z",
          updatedAt: "2026-05-01T12:00:00.000Z",
        }),
        { status: 201 },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await createSession({
    title: "  Project chat  ",
    projectId: "11111111-1111-4111-8111-111111111111",
  });

  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
    title: "Project chat",
    projectId: "11111111-1111-4111-8111-111111111111",
  });
});

/* ------------------------------------------------------------------ */
/*  fetchSession                                                       */
/* ------------------------------------------------------------------ */

test("fetchSession returns session details with encoded id", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          id: "sess/abc?",
          title: "Session Details",
          status: "idle" as const,
          activityType: "chat" as const,
          createdAt: "2026-05-01T12:00:00.000Z",
          updatedAt: "2026-05-01T12:00:00.000Z",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await fetchSession("sess/abc?");

  expect(fetchMock).toHaveBeenCalledWith("/api/sessions/sess%2Fabc%3F");
});

test("updateSessionTitle PATCHes the trimmed title and returns the session", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          id: "sess/abc?",
          title: "Renamed Session",
          status: "idle" as const,
          activityType: "chat" as const,
          createdAt: "2026-05-01T12:00:00.000Z",
          updatedAt: "2026-05-01T12:01:00.000Z",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await updateSessionTitle("sess/abc?", "  Renamed Session  ");

  expect(result.title).toBe("Renamed Session");
  const call = fetchMock.mock.calls[0]!;
  expect(call[0]).toBe("/api/sessions/sess%2Fabc%3F");
  expect(call[1].method).toBe("PATCH");
  expect(call[1].headers).toMatchObject({ "content-type": "application/json" });
  expect(JSON.parse(call[1].body as string)).toEqual({
    title: "Renamed Session",
  });
});

test("updateWorkflowYaml PATCHes the workflow YAML with encoded id", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          workflowId: "wf-renamed",
          yaml: "workflow:\n  id: wf-renamed\n",
          yamlPath: "/tmp/workflow.yaml",
          registryPath: "/tmp/registry.yaml",
          filename: "workflow.yaml",
          warnings: [],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await updateWorkflowYaml(
    "wf/1?",
    "workflow:\n  id: wf-renamed\n",
  );

  expect(result.workflowId).toBe("wf-renamed");
  const call = fetchMock.mock.calls[0]!;
  expect(call[0]).toBe("/api/workflows/wf%2F1%3F");
  expect(call[1].method).toBe("PATCH");
  expect(call[1].headers).toMatchObject({ "content-type": "application/json" });
  expect(JSON.parse(call[1].body as string)).toEqual({
    yaml: "workflow:\n  id: wf-renamed\n",
  });
});

/* ------------------------------------------------------------------ */
/*  deleteSession                                                      */
/* ------------------------------------------------------------------ */

test("deleteSession sends DELETE with encoded id", async () => {
  const fetchMock = vi.fn<FetchMock>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);

  await deleteSession("my-session");

  expect(fetchMock).toHaveBeenCalledWith("/api/sessions/my-session", {
    method: "DELETE",
  });
});

/* ------------------------------------------------------------------ */
/*  listChatMessages                                                   */
/* ------------------------------------------------------------------ */

test("listChatMessages returns messages for a session", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          messages: [
            {
              id: "msg-1",
              role: "user" as const,
              text: "Hello",
              createdAt: "2026-05-01T12:00:00.000Z",
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await listChatMessages("session-1");

  expect(result).toEqual({
    messages: [
      {
        id: "msg-1",
        role: "user",
        text: "Hello",
        createdAt: "2026-05-01T12:00:00.000Z",
      },
    ],
    outcomes: [],
    modelChoices: [],
  });
});

/**
 * The transcript boundary, on the client side of it.
 *
 * `chat.jsonl` refuses a line it cannot read whole, and the reason is that a
 * half-read line is worse than none: a reply whose conversation pointer was
 * quietly dropped looks exactly like a reply that never had one. That reason
 * does not stop at the process edge — the renderer is where a person actually
 * sees the answer, and it was reading the whole payload through a cast, which
 * promises the shape rather than checking it.
 */

const v2Message = (overrides: Record<string, unknown> = {}) => ({
  id: "turn-1:assistant:0",
  role: "assistant" as const,
  text: "answered",
  createdAt: "2026-05-01T12:00:00.000Z",
  turnId: "turn-1",
  schemaVersion: 2,
  conversationId: "session-1",
  kind: "chat",
  source: { kind: "conversation-turn", turnId: "turn-1" },
  // Both pointers, because the old parser dropped `execution` too and a
  // fixture without one would prove nothing about keeping it.
  execution: { runId: "turn-1", assignmentId: "assignment-1" },
  conversation: {
    conversationId: "session-1",
    activityId: "turn-1",
    turnId: "turn-1",
  },
  ...overrides,
});

const readyPlan = {
  id: "plan-1",
  goal: "Continue the conversation",
  summary: "Ready",
  status: "ready",
  requiredInputs: [],
  actions: [],
  warnings: [],
  createdAt: "2026-05-01T12:00:01.000Z",
};

const respondWith = (body: unknown) =>
  vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
  );

test("listChatMessages carries a version-2 line through whole", async () => {
  vi.stubGlobal("fetch", respondWith({ messages: [v2Message()] }));

  expect(await listChatMessages("session-1")).toEqual({
    messages: [v2Message()],
    outcomes: [],
    modelChoices: [],
  });
});

const outcomeMessage = (outcome: unknown) => ({
  id: "msg-outcome",
  role: "assistant" as const,
  text: "⚠️ youtube-manual-generation failed at step extract.",
  createdAt: "2026-05-01T12:00:00.000Z",
  speaker: {
    type: "agent",
    id: "youtube-extractor",
    name: "youtube-extractor",
  },
  outcome,
});

test("listChatMessages carries the outcome of a stopped run through whole", async () => {
  const message = outcomeMessage({
    taskId: "task-1",
    executionAttemptId: "attempt-1",
    status: "failed",
    workflowId: "youtube-manual-generation",
    stepId: "extract",
    reason: "Bundled YouTube media tools are unavailable.",
  });
  vi.stubGlobal("fetch", respondWith({ messages: [message] }));

  expect(await listChatMessages("session-1")).toEqual({
    messages: [message],
    outcomes: [],
    modelChoices: [],
  });
});

test("listChatMessages refuses a message whose outcome the contract cannot read", async () => {
  const unreadable = [
    { name: "taskId", outcome: { status: "failed", workflowId: "w" } },
    {
      name: "executionAttemptId",
      outcome: {
        taskId: "task-1",
        executionAttemptId: 9,
        status: "failed",
        workflowId: "w",
      },
    },
    {
      name: "status",
      outcome: { taskId: "task-1", status: "cancelled", workflowId: "w" },
    },
    { name: "workflowId", outcome: { taskId: "task-1", status: "blocked" } },
    {
      name: "stepId",
      outcome: {
        taskId: "task-1",
        status: "failed",
        workflowId: "w",
        stepId: 4,
      },
    },
    {
      name: "reason",
      outcome: {
        taskId: "task-1",
        status: "failed",
        workflowId: "w",
        reason: ["nope"],
      },
    },
  ];
  for (const entry of unreadable) {
    vi.stubGlobal("fetch", respondWith({ messages: [outcomeMessage(entry.outcome)] }));
    await expect(
      listChatMessages("session-1"),
      `an outcome with an unreadable ${entry.name} must be refused`,
    ).rejects.toThrow(/Invalid API response/);
  }
});

test("listChatMessages keeps the selections a turn was admitted on", async () => {
  // The durable record of which model answered lives on the turn request. The
  // client rebuilt that object field by field and dropped this one, so the
  // default-use notice survived only as long as the live stream frame: it
  // disappeared on reload, and from an older turn as soon as a newer one
  // started. Every past reply's model label went with it.
  const admittedSelections = {
    reviewer: {
      provider: "connection:abc",
      model: "gpt-5.4-mini",
      source: "app-default" as const,
      reason: "agent-default" as const,
      caller: "agent" as const,
    },
  };
  const message = v2Message({
    turnRequest: {
      fingerprint: "a".repeat(64),
      expectedReplies: 1,
      admittedSelections,
    },
  });
  vi.stubGlobal("fetch", respondWith({ messages: [message] }));

  const result = await listChatMessages("session-1");
  expect(result.messages[0]?.turnRequest?.admittedSelections).toEqual(
    admittedSelections,
  );
});

test("listChatMessages refuses a turn whose recorded selection cannot be read", async () => {
  // Half a record would render a notice naming something no execution
  // recorded, which is worse than showing none.
  for (const admittedSelections of [
    { reviewer: { provider: "connection:abc", model: "gpt-5.4-mini" } },
    { reviewer: "gpt-5.4-mini" },
    { "": { provider: "a", model: "b", source: "agent", reason: "explicit-agent-choice", caller: "agent" } },
    "reviewer",
  ]) {
    vi.stubGlobal(
      "fetch",
      respondWith({
        messages: [
          v2Message({
            turnRequest: {
              fingerprint: "a".repeat(64),
              expectedReplies: 1,
              admittedSelections,
            },
          }),
        ],
      }),
    );
    await expect(listChatMessages("session-1")).rejects.toThrow(
      /Invalid API response/,
    );
  }
});

test("listChatMessages refuses a payload that is not a list of messages", async () => {
  for (const body of [{}, { messages: "none" }, { messages: [null] }, []]) {
    vi.stubGlobal("fetch", respondWith(body));
    await expect(listChatMessages("session-1")).rejects.toThrow(
      /Invalid API response/,
    );
  }
});

test("listChatMessages refuses a message the contract cannot read", async () => {
  const unreadable = [
    { name: "role", message: v2Message({ role: "narrator" }) },
    { name: "version", message: v2Message({ schemaVersion: 3 }) },
    { name: "conversationId", message: v2Message({ conversationId: 7 }) },
    { name: "kind", message: v2Message({ kind: "task-status" }) },
    { name: "source", message: v2Message({ source: undefined }) },
    {
      name: "source turn",
      message: v2Message({
        source: { kind: "conversation-turn", turnId: "another-turn" },
      }),
    },
    {
      name: "execution",
      message: v2Message({ execution: { runId: "turn-1" } }),
    },
    {
      name: "pointer",
      message: v2Message({
        conversation: {
          conversationId: "session-1",
          activityId: "another-turn",
          turnId: "turn-1",
        },
      }),
    },
  ];
  for (const entry of unreadable) {
    vi.stubGlobal("fetch", respondWith({ messages: [entry.message] }));
    await expect(
      listChatMessages("session-1"),
      `a message with an unreadable ${entry.name} must be refused`,
    ).rejects.toThrow(/Invalid API response/);
  }
});

test("a message carrying conversation fields without the version is refused", async () => {
  for (const field of [
    "conversationId",
    "kind",
    "source",
    "conversation",
  ] as const) {
    const message = v2Message();
    const undeclared: Record<string, unknown> = {
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      turnId: message.turnId,
      [field]: message[field],
    };
    vi.stubGlobal("fetch", respondWith({ messages: [undeclared] }));
    await expect(
      listChatMessages("session-1"),
      `a line carrying ${field} without schemaVersion must be refused`,
    ).rejects.toThrow(/Invalid API response/);
  }
});

test("postChatMessage keeps the conversation evidence on what it returns", async () => {
  vi.stubGlobal(
    "fetch",
    respondWith({
      user: v2Message({
        id: "turn-1:user",
        role: "user",
        text: "Hi",
        turnRequest: { fingerprint: "a".repeat(64), expectedReplies: 1 },
        conversation: undefined,
      }),
      assistant: v2Message(),
      plan: readyPlan,
    }),
  );

  const result = await postChatMessage("session-1", "Hi");
  expect(result.assistant).toEqual(v2Message());
  expect(result.user.turnRequest).toEqual({
    fingerprint: "a".repeat(64),
    expectedReplies: 1,
  });
});

test("postChatMessage refuses a reply it cannot read whole", async () => {
  vi.stubGlobal(
    "fetch",
    respondWith({
      user: v2Message({ id: "turn-1:user", role: "user", text: "Hi" }),
      assistant: v2Message({ conversation: { conversationId: "session-1" } }),
      plan: readyPlan,
    }),
  );

  // Named specifically: a refusal that came from the plan instead would
  // satisfy a looser assertion while proving nothing about the reply.
  await expect(postChatMessage("session-1", "Hi")).rejects.toThrow(
    /expected ChatMessage\.conversation$/,
  );
});

/* ------------------------------------------------------------------ */
/*  postChatMessage                                                    */
/* ------------------------------------------------------------------ */

test("postChatMessage sends text in a JSON body", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          user: {
            id: "msg-user",
            role: "user" as const,
            text: "Hi there",
            createdAt: "2026-05-01T12:00:00.000Z",
          },
          assistant: {
            id: "msg-ai",
            role: "assistant" as const,
            text: "Hi!",
            createdAt: "2026-05-01T12:00:01.000Z",
          },
          plan: {
            id: "plan-1",
            goal: "Continue the conversation",
            summary: "Ready",
            status: "ready",
            requiredInputs: [],
            actions: [],
            warnings: [],
            createdAt: "2026-05-01T12:00:01.000Z",
          },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await postChatMessage("session-1", "Hi there");

  expect(result).toMatchObject({
    user: { text: "Hi there" },
    assistant: { text: "Hi!" },
  });
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
    text: "Hi there",
  });
});

test("chat clients send only the explicitly selected project context", async () => {
  const projectContext = {
    projectId: "11111111-1111-4111-8111-111111111111",
    includeBrief: true,
    fileNames: ["brief.md"],
  };
  const fetchMock = vi.fn<FetchMock>(async (url) =>
    url.endsWith("/agent-chat/messages")
      ? new Response(JSON.stringify({ user: {}, replies: [], meta: { replies: [] } }))
      : new Response(
          JSON.stringify({
            user: { id: "u", role: "user", text: "Use it", createdAt: "2026-08-04T00:00:00.000Z" },
            assistant: { id: "a", role: "assistant", text: "Done", createdAt: "2026-08-04T00:00:01.000Z" },
            plan: {
              id: "p",
              goal: "Use it",
              summary: "Ready",
              status: "ready",
              requiredInputs: [],
              actions: [],
              warnings: [],
              createdAt: "2026-08-04T00:00:01.000Z",
            },
          }),
        ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await postChatMessage("session-1", "Use it", { projectContext });
  await postAgentChatMessage("session-1", "Use it", {
    agentNames: ["analyst"],
    projectContext,
  });

  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
    text: "Use it",
    projectContext,
  });
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({
    text: "Use it",
    agentNames: ["analyst"],
    projectContext,
  });
});

test("postChatMessage rejects a response without its required RunPlan", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          user: {
            id: "msg-user",
            role: "user",
            text: "Hi",
            createdAt: "2026-05-01T12:00:00.000Z",
          },
          assistant: {
            id: "msg-ai",
            role: "assistant",
            text: "Hello",
            createdAt: "2026-05-01T12:00:01.000Z",
          },
        }),
        { status: 200 },
      ),
    ),
  );

  await expect(postChatMessage("session-1", "Hi")).rejects.toThrow(
    "Invalid API response: expected PostChatMessageResponse",
  );
});

test("getSessionRunPlan rehydrates the persisted plan", async () => {
  const plan = {
    id: "plan-1",
    goal: "Write a report",
    summary: "Ready",
    status: "ready",
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: "2026-07-10T00:00:00.000Z",
  };
  const fetchMock = vi.fn<FetchMock>(
    async () => new Response(JSON.stringify({ plan }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(getSessionRunPlan("session-1")).resolves.toEqual(plan);
  expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/run-plan");
});

test("getSessionRunPlan rejects a malformed lifecycle status", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          plan: {
            id: "plan-1",
            goal: "Write a report",
            summary: "Ready",
            status: "mystery",
            requiredInputs: [],
            actions: [],
            warnings: [],
            createdAt: "2026-07-10T00:00:00.000Z",
          },
        }),
        { status: 200 },
      ),
    ),
  );

  await expect(getSessionRunPlan("session-1")).rejects.toThrow(
    "Invalid API response: expected RunPlan",
  );
});

test("selectSessionWorkflow sends the expected plan id for compare-and-swap", async () => {
  const plan = {
    id: "plan-2",
    goal: "Write a report",
    summary: "Ready",
    status: "ready",
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: "2026-07-10T00:00:00.000Z",
  };
  const fetchMock = vi.fn<FetchMock>(
    async () => new Response(JSON.stringify({ plan }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    selectSessionWorkflow("session-1", "wf-1", "plan-1"),
  ).resolves.toEqual(plan);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/session-1/run-plan/workflow",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ workflowId: "wf-1", expectedPlanId: "plan-1" }),
    }),
  );
});

/* ------------------------------------------------------------------ */
/*  listWorkflows                                                      */
/* ------------------------------------------------------------------ */

test("listWorkflows returns workflows from the API", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          workflows: [
            {
              id: "wf-1",
              description: "Summarize",
              tags: ["summary"],
              capabilities: ["summarize"],
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await listWorkflows();

  expect(result).toEqual([
    {
      id: "wf-1",
      description: "Summarize",
      tags: ["summary"],
      capabilities: ["summarize"],
    },
  ]);
  expect(fetchMock).toHaveBeenCalledWith("/api/workflows");
});

test("getWorkflowYaml returns YAML from a workflow detail response", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify({ yaml: "workflow:\n  id: wf-1\n" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await getWorkflowYaml("wf/1?");

  expect(result).toContain("id: wf-1");
  expect(fetchMock).toHaveBeenCalledWith("/api/workflows/wf%2F1%3F");
});

test("getWorkflowStages returns declared stages from a workflow detail response", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          yaml: "workflow:\n  id: wf-1\n",
          stages: [
            {
              id: "write",
              team: "writing-team",
              inputArtifact: "incoming-brief.md",
              resultArtifact: "final-draft.md",
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await getWorkflowStages("wf/1?");

  expect(result).toEqual([
    {
      id: "write",
      team: "writing-team",
      inputArtifact: "incoming-brief.md",
      resultArtifact: "final-draft.md",
    },
  ]);
  expect(fetchMock).toHaveBeenCalledWith("/api/workflows/wf%2F1%3F");
});

test("getWorkflowStages falls back to an empty list when the detail omits stages", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify({ yaml: "workflow:\n  id: wf-1\n" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(getWorkflowStages("wf-1")).resolves.toEqual([]);
});

test("getWorkflowYaml preserves API error messages", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify({ error: "Workflow not found: wf-404" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(getWorkflowYaml("wf-404")).rejects.toThrow(
    "Workflow not found: wf-404",
  );
});

test("deleteWorkflow sends DELETE with encoded workflow id", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(null, {
        status: 204,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await deleteWorkflow("wf/1?");

  expect(fetchMock).toHaveBeenCalledWith("/api/workflows/wf%2F1%3F", {
    method: "DELETE",
  });
});

test("deleteWorkflow preserves API error messages", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify({ error: "Workflow not found: wf-404" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(deleteWorkflow("wf-404")).rejects.toThrow(
    "Workflow not found: wf-404",
  );
});

/* ------------------------------------------------------------------ */
/*  listSessionFiles                                                   */
/* ------------------------------------------------------------------ */

test("listSessionFiles returns files with encoded session id", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          files: [
            {
              name: "report.pdf",
              size: 12345,
              uploadedAt: "2026-05-01T12:00:00.000Z",
              parseStatus: "parsed" as const,
              parsedAt: "2026-05-01T12:01:00.000Z",
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await listSessionFiles("session-1");

  expect(result).toEqual([
    {
      name: "report.pdf",
      size: 12345,
      uploadedAt: "2026-05-01T12:00:00.000Z",
      parseStatus: "parsed",
      parsedAt: "2026-05-01T12:01:00.000Z",
    },
  ]);
});

/* ------------------------------------------------------------------ */
/*  uploadSessionFile                                                  */
/* ------------------------------------------------------------------ */

test("uploadSessionFile sends file body with correct content-type", async () => {
  const file = new File(["hello"], "report.txt", { type: "text/plain" });
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          name: "report.txt",
          size: 5,
          uploadedAt: "2026-05-01T12:00:00.000Z",
          parseStatus: "pending" as const,
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await uploadSessionFile("session-1", file);

  const call = fetchMock.mock.calls[0]!;
  expect(call[0]).toBe("/api/sessions/session-1/files");
  expect(call[1].method).toBe("POST");
  expect(call[1].headers).toMatchObject({
    "content-type": "text/plain",
    "x-filename": "report.txt",
  });
});

test("uploadSessionFile falls back to application/octet-stream when file.type is empty", async () => {
  const file = new File(["data"], "unknown", { type: "" });
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          name: "unknown",
          size: 4,
          uploadedAt: "2026-05-01T12:00:00.000Z",
          parseStatus: "pending" as const,
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await uploadSessionFile("session-1", file);

  const call = fetchMock.mock.calls[0]!;
  expect(call[1].headers).toMatchObject({
    "content-type": "application/octet-stream",
  });
});

/* ------------------------------------------------------------------ */
/*  deleteSessionFile                                                  */
/* ------------------------------------------------------------------ */

test("deleteSessionFile sends DELETE with encoded id and filename", async () => {
  const fetchMock = vi.fn<FetchMock>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);

  await deleteSessionFile("session-1", "report.pdf");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/session-1/files/report.pdf",
    { method: "DELETE" },
  );
});

test("deleteSessionFile preserves API error messages", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify({ error: "File not found" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(deleteSessionFile("session-1", "missing.pdf")).rejects.toThrow(
    "File not found",
  );
});

/* ------------------------------------------------------------------ */
/*  cancelSessionTask                                                  */
/* ------------------------------------------------------------------ */

test("cancelSessionTask sends DELETE and returns the persisted task", async () => {
  const cancelledTask = {
    id: "task/1",
    sessionId: "session/1",
    runId: "run-1",
    workflowId: "wf-1",
    brief: "Draft a report",
    status: "cancelled" as const,
    createdAt: "2026-05-01T12:00:00.000Z",
    completedAt: "2026-05-01T12:01:00.000Z",
    cwd: "/workspace",
    error: "Cancelled by user",
  };
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify(cancelledTask), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await cancelSessionTask("session/1", "task/1");

  expect(result).toEqual(cancelledTask);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/session%2F1/tasks/task%2F1",
    { method: "DELETE" },
  );
});

test("cancelSessionTask preserves API error messages", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify({ error: "Task cancellation failed" }), {
        headers: { "content-type": "application/json" },
        status: 500,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(cancelSessionTask("session-1", "task-1")).rejects.toThrow(
    "Task cancellation failed",
  );
});

/* ------------------------------------------------------------------ */
/*  resumeSessionTask                                                  */
/* ------------------------------------------------------------------ */

test("resumeSessionTask sends POST and returns the recovered task", async () => {
  const recoveredTask = {
    id: "task/1",
    sessionId: "session/1",
    runId: "run-1",
    workflowId: "wf-1",
    brief: "Draft a report",
    status: "running" as const,
    createdAt: "2026-05-01T12:00:00.000Z",
    cwd: "/workspace",
    executionAttemptId: "attempt-2",
    executionAttemptNumber: 2,
    executionKind: "recovery" as const,
    recoveryCount: 1,
  };
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify(recoveredTask), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await resumeSessionTask("session/1", "task/1");

  expect(result).toEqual(recoveredTask);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/session%2F1/tasks/task%2F1/resume",
    { method: "POST" },
  );
});

test("resumeSessionTask preserves API error messages", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify({ error: "Task is not resumable" }), {
        headers: { "content-type": "application/json" },
        status: 409,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(resumeSessionTask("session-1", "task-1")).rejects.toThrow(
    "Task is not resumable",
  );
});

/* ------------------------------------------------------------------ */
/*  startSessionTask                                                   */
/* ------------------------------------------------------------------ */

test("startSessionTask succeeds with workflowId and optional brief", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          id: "task-1",
          sessionId: "session-1",
          runId: "run-1",
          workflowId: "wf-1",
          brief: "Draft a report",
          status: "queued" as const,
          createdAt: "2026-05-01T12:00:00.000Z",
          cwd: "/workspace",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await startSessionTask("session-1", { workflowId: "wf-1" }, "Draft a report");

  expect(result.status).toBe("queued");
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
    workflowId: "wf-1",
    brief: "Draft a report",
  });
});

test("startSessionTask sends the project context selected before Apply", async () => {
  const fetchMock = vi.fn<FetchMock>(async () =>
    new Response(
      JSON.stringify({
        id: "task-1",
        sessionId: "session-1",
        runId: "run-1",
        workflowId: "wf-1",
        brief: "Draft a report",
        status: "queued",
        createdAt: "2026-05-01T12:00:00.000Z",
        cwd: "/workspace",
      }),
      { status: 202 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const projectContext = {
    projectId: "11111111-1111-4111-8111-111111111111",
    includeBrief: true,
    fileNames: ["facts.md"],
  };

  await startSessionTask("session-1", { workflowId: "wf-1" }, undefined, projectContext);

  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
    workflowId: "wf-1",
    projectContext,
  });
});

test("startSessionTask without brief omits the brief field", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          id: "task-1",
          sessionId: "session-1",
          runId: "run-1",
          workflowId: "wf-1",
          brief: "",
          status: "queued" as const,
          createdAt: "2026-05-01T12:00:00.000Z",
          cwd: "/workspace",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await startSessionTask("session-1", { workflowId: "wf-1" });

  const body: unknown = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
  expect(body).toEqual({ workflowId: "wf-1", brief: undefined });
});

test("startSessionTask rejects a malformed task response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          id: "task-1",
          sessionId: "session-1",
          runId: "run-1",
          workflowId: "wf-1",
          brief: "",
          status: "queued",
          createdAt: "2026-05-01T12:00:00.000Z",
          cwd: 42,
        }),
        { status: 200 },
      ),
    ),
  );

  await expect(startSessionTask("session-1", { workflowId: "wf-1" })).rejects.toThrow(
    "Invalid API response: expected SessionTask",
  );
});

test("startSessionTask throws SessionTaskStartError when response is not ok", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify({ error: "Workflow not found" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(startSessionTask("session-1", { workflowId: "wf-999" })).rejects.toThrow(
    SessionTaskStartError,
  );
  await expect(startSessionTask("session-1", { workflowId: "wf-999" })).rejects.toMatchObject({
    message: "Workflow not found",
    name: "SessionTaskStartError",
  });
});

test("startSessionTask SessionTaskStartError falls back to HTTP status when JSON parsing fails", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response("internal server error", {
        headers: { "content-type": "text/plain" },
        status: 500,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(startSessionTask("session-1", { workflowId: "wf-999" })).rejects.toThrow(
    SessionTaskStartError,
  );
  await expect(startSessionTask("session-1", { workflowId: "wf-999" })).rejects.toMatchObject({
    message: "500 Internal Server Error",
  });
});

test("startSessionTask SessionTaskStartError carries assistant message when provided", async () => {
  const assistantMsg = {
    id: "msg-1",
    role: "assistant" as const,
    text: "Fallback response",
    createdAt: "2026-05-01T12:00:00.000Z",
  };
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          error: "Workflow error",
          assistant: assistantMsg,
        }),
        {
          headers: { "content-type": "application/json" },
          status: 400,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(startSessionTask("session-1", { workflowId: "wf-999" })).rejects.toThrow(
    SessionTaskStartError,
  );
  await expect(startSessionTask("session-1", { workflowId: "wf-999" })).rejects.toMatchObject({
    assistant: assistantMsg,
  });
});

test("startSessionTask preserves workflow validation detail and failed plan", async () => {
  const failedPlan = {
    id: "plan-failed",
    goal: "Write a report",
    summary: "Workflow launch failed.",
    status: "failed" as const,
    selectedWorkflow: {
      id: "wf-invalid",
      confidence: "high" as const,
      rationale: "Explicitly selected.",
    },
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: "2026-07-10T12:00:00.000Z",
  };
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          error: "Workflow is invalid",
          detail: "Discussion settings cannot target a routing stage.",
          plan: failedPlan,
        }),
        {
          headers: { "content-type": "application/json" },
          status: 400,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(startSessionTask("session-1", { workflowId: "wf-invalid" })).rejects.toMatchObject({
    message: "Workflow is invalid",
    detail: "Discussion settings cannot target a routing stage.",
    plan: failedPlan,
  });
});

test("generateSessionResearchPlan submits the current RunPlan revision", async () => {
  const attempt = {
    schemaVersion: 3,
    attemptId: "attempt-1",
    planningRevisionId: "planning-revision-1",
    expectedPlanId: "plan-1",
    revision: 0,
    retryCount: 0,
    status: "queued",
    phase: "accepted",
    route: "terra_only",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    stages: {},
    candidates: {},
    findings: [],
  };
  const fetchMock = vi.fn<FetchMock>(async () =>
    new Response(JSON.stringify({ attempt }), {
      headers: { "content-type": "application/json" },
      status: 202,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    generateSessionResearchPlan("session-1", "plan-1"),
  ).resolves.toEqual(attempt);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/sessions/session-1/run-plan/research-plan"),
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedPlanId: "plan-1" }),
    }),
  );
});

test("generateSessionResearchPlan preserves safe planner diagnostics", async () => {
  const fetchMock = vi.fn<FetchMock>(async () =>
    new Response(
      JSON.stringify({
        error: "Research planner could not produce a valid plan",
        detail: "plan.tasks contains an invalid reference.",
        attemptPath: "research-planning/attempts/attempt-1",
      }),
      {
        headers: { "content-type": "application/json" },
        status: 500,
      },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    generateSessionResearchPlan("session-diagnostics", "plan-1"),
  ).rejects.toThrow(
    /Validation: plan\.tasks contains an invalid reference\..*Diagnostics: research-planning\/attempts\/attempt-1\/attempt\.json/s,
  );
});

test("planning event streams reconnect and deliver the terminal durable snapshot", async () => {
  const terminalAttempt = {
    schemaVersion: 3,
    attemptId: "attempt-1",
    planningRevisionId: "planning-revision-1",
    expectedPlanId: "plan-1",
    revision: 1,
    retryCount: 0,
    status: "succeeded",
    phase: "ready",
    route: "terra_only",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:01.000Z",
    completedAt: "2026-07-25T12:00:01.000Z",
    stages: {},
    candidates: {},
    findings: [],
    finalRunPlanId: "plan-2",
  };
  const event = {
    sequence: 0,
    type: "planning.status",
    timestamp: "2026-07-25T12:00:01.000Z",
    snapshot: terminalAttempt,
  };
  const fetchMock = vi
    .fn<FetchMock>()
    .mockRejectedValueOnce(new TypeError("stream disconnected"))
    .mockResolvedValueOnce(
      new Response(`event: planning.status\ndata: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const onSnapshot = vi.fn();

  await openSessionResearchPlanAttemptStream({
    sessionId: "session-1",
    attemptId: "attempt-1",
    signal: new AbortController().signal,
    onSnapshot,
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(onSnapshot).toHaveBeenCalledWith(terminalAttempt);
});

test("approveSessionResearchPlan submits the exact proposal hash", async () => {
  const proposalHash = "a".repeat(64);
  const plan = {
    id: "plan-3",
    goal: "Research a market",
    summary: "Ready",
    status: "ready" as const,
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: "2026-07-17T12:00:00.000Z",
  };
  const fetchMock = vi.fn<FetchMock>(async () =>
    new Response(JSON.stringify({ plan }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    approveSessionResearchPlan("session-1", "plan-2", proposalHash),
  ).resolves.toEqual(plan);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/sessions/session-1/run-plan/research-plan/approve"),
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        expectedPlanId: "plan-2",
        expectedResearchPlanHash: proposalHash,
      }),
    }),
  );
});

/* ------------------------------------------------------------------ */
/*  listSessionTasks                                                   */
/* ------------------------------------------------------------------ */

test("listSessionTasks returns tasks for a session", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          tasks: [
            {
              id: "task-1",
              sessionId: "session-1",
              runId: "run-1",
              workflowId: "wf-1",
              brief: "Test",
              status: "queued" as const,
              createdAt: "2026-05-01T12:00:00.000Z",
              cwd: "/workspace",
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await listSessionTasks("session-1");

  expect(result).toEqual([
    {
      id: "task-1",
      sessionId: "session-1",
      runId: "run-1",
      workflowId: "wf-1",
      brief: "Test",
      status: "queued",
      createdAt: "2026-05-01T12:00:00.000Z",
      cwd: "/workspace",
    },
  ]);
});

test("listSessionTasks rejects the whole response when one task is malformed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          tasks: [
            {
              id: "task-1",
              sessionId: "session-1",
              runId: "run-1",
              workflowId: "wf-1",
              brief: "Test",
              status: "queued",
              createdAt: "2026-05-01T12:00:00.000Z",
              cwd: "/workspace",
            },
            { id: "task-2", status: "queued" },
          ],
        }),
        { status: 200 },
      ),
    ),
  );

  await expect(listSessionTasks("session-1")).rejects.toThrow(
    "Invalid API response: expected { tasks: SessionTask[] }",
  );
});

/**
 * The half of a session's state the transcript cannot hold.
 *
 * A turn that was interrupted has no message to show for it, so the endpoint
 * returns what happened beside what was said. It is validated on arrival for
 * the same reason every message is: a renderer that trusts an unchecked
 * `state` string will happily offer a Retry for a turn whose record says
 * nothing of the kind.
 */
test("listChatMessages returns the transcript with its turn outcomes", async () => {
  vi.stubGlobal(
    "fetch",
    respondWith({
      messages: [v2Message({ role: "user", id: "turn-1:user" })],
      outcomes: [
        {
          turnId: "turn-1",
          state: "interrupted",
          code: "provider_interrupted",
          retryable: true,
        },
      ],
    }),
  );

  expect(await listChatMessages("session-1")).toEqual({
    messages: [v2Message({ role: "user", id: "turn-1:user" })],
    outcomes: [
      {
        turnId: "turn-1",
        state: "interrupted",
        code: "provider_interrupted",
        retryable: true,
      },
    ],
    modelChoices: [],
  });
});

test("listChatMessages treats a response with no outcomes as none", async () => {
  vi.stubGlobal("fetch", respondWith({ messages: [v2Message()] }));

  expect(await listChatMessages("session-1")).toEqual({
    messages: [v2Message()],
    outcomes: [],
    modelChoices: [],
  });
});

test.each([null, [12], [""], "turn-1"])("listChatMessages refuses malformed active turns: %j", async (activeTurnIds) => {
  vi.stubGlobal("fetch", respondWith({ messages: [], activeTurnIds }));
  await expect(listChatMessages("session-1")).rejects.toThrow("activeTurnIds");
});

test("listChatMessages refuses an outcome the contract cannot read", async () => {
  const unreadable = [
    { turnId: "turn-1", state: "vanished", code: "provider_interrupted", retryable: true },
    { turnId: "turn-1", state: "interrupted", code: "Error: ECONNRESET at /Users/x", retryable: true },
    { turnId: "turn-1", state: "interrupted", code: "provider_interrupted" },
    { turnId: "", state: "interrupted", code: "provider_interrupted", retryable: true },
    null,
  ];
  for (const outcome of unreadable) {
    vi.stubGlobal(
      "fetch",
      respondWith({ messages: [v2Message()], outcomes: [outcome] }),
    );
    await expect(listChatMessages("session-1")).rejects.toThrow(
      /Invalid API response/,
    );
  }
});

test("listChatMessages refuses an outcome carrying fields the contract does not name", async () => {
  // The whole point of the outcome contract is that there is nowhere for
  // provider prose to travel. A guard that only checks the fields it knows
  // about lets every other field through untouched, so a server bug — or a
  // future field added without thought — would reach the renderer as
  // unvalidated text under an object the renderer trusts.
  for (const extra of [
    { providerText: "Error: ECONNRESET at /Users/someone/secret-project" },
    { rawError: "sk-proj-abcdef" },
    { detail: "the user asked about their salary" },
  ]) {
    vi.stubGlobal(
      "fetch",
      respondWith({
        messages: [v2Message()],
        outcomes: [
          {
            turnId: "turn-1",
            state: "interrupted",
            code: "provider_interrupted",
            retryable: true,
            ...extra,
          },
        ],
      }),
    );
    await expect(listChatMessages("session-1")).rejects.toThrow(
      /Invalid API response/,
    );
  }
});

/* ------------------------------------------------------------------ */
/*  title attempts                                                     */
/* ------------------------------------------------------------------ */

const TITLE_ATTEMPT = {
  operation: "selected-agent-chat",
  owner: "turn-1",
  attemptId: "attempt-1",
  selection: {
    provider: "openai",
    model: "app-default-model",
    source: "app-default",
    reason: "agent-default",
    caller: "title",
  },
  at: "2026-09-09T12:00:00.000Z",
} as const;

function sessionResponse(extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: "session-1",
      title: "Reviewing The Supply Agreement",
      status: "idle" as const,
      activityType: "chat" as const,
      createdAt: "2026-09-09T12:00:00.000Z",
      updatedAt: "2026-09-09T12:00:00.000Z",
      ...extra,
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

test("a reopened session keeps the record of which model named it", async () => {
  // The browser is where this is shown, and the decoder rebuilds a summary
  // field by field — so a field it forgets is silently gone on reload, and the
  // page cannot say which model was used however carefully the server wrote it
  // down.
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async () => sessionResponse({ titleAttempts: [TITLE_ATTEMPT] })),
  );

  const session = await fetchSession("session-1");

  expect(session.titleAttempts).toEqual([TITLE_ATTEMPT]);
});

test("a session that recorded no title attempt simply has none", async () => {
  vi.stubGlobal("fetch", vi.fn<FetchMock>(async () => sessionResponse()));

  const session = await fetchSession("session-1");

  expect(session.titleAttempts).toBeUndefined();
});

test("a title record the browser cannot read is refused, not half-shown", async () => {
  for (const broken of [
    "not a list",
    [{ ...TITLE_ATTEMPT, operation: "invented" }],
    [{ ...TITLE_ATTEMPT, owner: "" }],
    [{ ...TITLE_ATTEMPT, selection: { ...TITLE_ATTEMPT.selection, caller: "agent" } }],
    [{ ...TITLE_ATTEMPT, at: "the other day" }],
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () => sessionResponse({ titleAttempts: broken })),
    );

    await expect(fetchSession("session-1")).rejects.toThrow(
      "Invalid API response: expected SessionSummary.titleAttempts",
    );
  }
});

/* ------------------------------------------------------------------ */
/*  session responses are read, not assumed                            */
/* ------------------------------------------------------------------ */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

const READABLE_SESSION = {
  id: "session-1",
  title: "Reviewing The Supply Agreement",
  status: "idle",
  activityType: "chat",
  createdAt: "2026-09-09T12:00:00.000Z",
  updatedAt: "2026-09-09T12:00:00.000Z",
} as const;

test("listSessions refuses a list holding a session it cannot read", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async () =>
      jsonResponse({ sessions: [READABLE_SESSION, { ...READABLE_SESSION, status: "paused" }] }),
    ),
  );

  await expect(listSessions()).rejects.toThrow(
    "Invalid API response: expected SessionSummary.status",
  );
});

test("listSessions refuses a payload that is not a list of sessions", async () => {
  vi.stubGlobal("fetch", vi.fn<FetchMock>(async () => jsonResponse({ sessions: "none" })));

  await expect(listSessions()).rejects.toThrow(
    "Invalid API response: expected SessionSummary list",
  );
});

test("fetchSession refuses a session without an id", async () => {
  const withoutId = {
    title: READABLE_SESSION.title,
    status: READABLE_SESSION.status,
    activityType: READABLE_SESSION.activityType,
    createdAt: READABLE_SESSION.createdAt,
    updatedAt: READABLE_SESSION.updatedAt,
  };
  vi.stubGlobal("fetch", vi.fn<FetchMock>(async () => jsonResponse(withoutId)));

  await expect(fetchSession("session-1")).rejects.toThrow(
    "Invalid API response: expected SessionSummary.id",
  );
});

test("updateSessionTitle refuses a renamed session it cannot read", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async () => jsonResponse({ ...READABLE_SESSION, activityType: "meeting" })),
  );

  await expect(updateSessionTitle("session-1", "Renamed")).rejects.toThrow(
    "Invalid API response: expected SessionSummary.activityType",
  );
});

test("list, detail, and rename keep a session's optional fields", async () => {
  const withOptionalFields = {
    ...READABLE_SESSION,
    projectId: "project-7",
    origin: {
      kind: "scheduled",
      scheduleId: "sch_12345678-1234-1234-1234-123456789abc",
    },
    titleAttempts: [TITLE_ATTEMPT],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async (url, init) =>
      jsonResponse(
        url.endsWith("/sessions") && init?.method === undefined
          ? { sessions: [withOptionalFields] }
          : withOptionalFields,
      ),
    ),
  );

  const [listed] = await listSessions();
  const detailed = await fetchSession("session-1");
  const renamed = await updateSessionTitle("session-1", "Renamed");

  for (const session of [listed, detailed, renamed]) {
    expect(session).toEqual(withOptionalFields);
  }
});

/** The body of the first POST, narrowed rather than asserted non-null. */
function createCallBody(fetchMock: { mock: { calls: unknown[][] } }): string {
  const [call] = fetchMock.mock.calls;
  expect(call).toBeDefined();
  if (!call) throw new Error("fetch was not called");
  const [, init] = call;
  expect(init).toBeDefined();
  if (!init || typeof init !== "object" || !("body" in init)) {
    throw new Error("fetch was called without a request body");
  }
  const { body } = init;
  expect(typeof body).toBe("string");
  return String(body);
}

test("createSession sends a client-minted claim as an id and creation token pair", async () => {
  const claim = {
    id: "22222222-2222-4222-8222-222222222222",
    creationToken: "33333333-3333-4333-8333-333333333333",
  };
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(
        JSON.stringify({
          id: claim.id,
          title: "Untitled session",
          status: "idle" as const,
          activityType: "chat" as const,
          createdAt: "2026-05-01T12:00:00.000Z",
          updatedAt: "2026-05-01T12:00:00.000Z",
        }),
        { status: 201 },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const created = await createSession(claim);

  expect(created.id).toBe(claim.id);
  expect(JSON.parse(createCallBody(fetchMock))).toEqual(claim);
});

/**
 * Aborting the caller's own controller must abort the request in flight. The
 * assertion is on the signal the fetch actually received, so a client that
 * dropped the caller's signal and passed a fresh one of its own would fail
 * here rather than quietly ignoring cancellation.
 */
test("createSession aborts the request when the caller's signal aborts", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const fetchMock = vi.fn<FetchMock>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        observed = init?.signal ?? undefined;
        observed?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const pending = createSession({ signal: controller.signal });
  await vi.waitFor(() => expect(observed).toBeDefined());
  expect(observed?.aborted).toBe(false);

  controller.abort();

  expect(observed?.aborted).toBe(true);
  await expect(pending).rejects.toThrow();
});

/**
 * A create nobody is going to answer must not hold a draft hostage. Driven by
 * fake timers so the deadline is asserted, not waited out.
 */
test("createSession aborts a request that outlives its timeout", async () => {
  vi.useFakeTimers();
  try {
    let observed: AbortSignal | undefined;
    const fetchMock = vi.fn<FetchMock>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          observed = init?.signal ?? undefined;
          observed?.addEventListener("abort", () => {
            reject(new DOMException("TimeoutError", "TimeoutError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Rejection handling is attached before time moves, so the rejection
    // cannot arrive unobserved.
    const settled = expect(createSession({})).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).toBeDefined();
    expect(observed?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(CREATE_SESSION_TIMEOUT_MS);

    expect(observed?.aborted).toBe(true);
    await settled;
  } finally {
    vi.useRealTimers();
  }
});

test("createSession refuses a response that is not a session summary", async () => {
  const fetchMock = vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify({ id: "new-session", title: 42 }), {
        headers: { "content-type": "application/json" },
        status: 201,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);

  // The body is another process's output. Handing it back unchecked would put
  // a malformed session into every state map keyed by it.
  await expect(createSession({})).rejects.toThrow(
    "Invalid API response: expected SessionSummary",
  );
});
