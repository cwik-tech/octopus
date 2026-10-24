/**
 * The task-scoped model choice, as the active task pane presents it.
 *
 * Driven through TaskBody rather than the panel module, because what has to be
 * true is that a task waiting on a model choice *shows the decision* — not that
 * some component exists. The approval goes to the task's own endpoint: this
 * decision is not human input and not the chat model choice, and routing it
 * through either would approve one thing while a person was shown another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskBody } from "../task-body";
import type { TaskRunEntry } from "../task-strip";
import type { RunEvent } from "../../stage-renderers/index";
import type { SessionTask } from "@contracts/sessions";

const SESSION_ID = "sess-1";
const TASK_ID = "task-1";
const APPROVE_BUTTON = "Retry this Agent using app default";

const offer = {
  offerId: "offer-1",
  scope: { kind: "task" as const, sessionId: SESSION_ID, taskId: TASK_ID },
  agentName: "defaultrecoveryworker",
  logicalInvocationId: "finalize",
  expectedRevision: "3",
  failedChoice: {
    provider: "connection:absentconnection",
    model: "fake/never-configured",
  },
  proposedDefault: { provider: "connection:present", model: "fake/default" },
  reason: "missing-credential" as const,
};

/** One completed step already in the buffer, as a waiting task really has. */
const completedPredecessor: RunEvent[] = [
  {
    id: "evt-1",
    runId: "run-1",
    type: "workflow.step.completed",
    ts: Date.parse("2026-09-06T10:00:00.000Z"),
    stageName: "draft",
    agentName: "draft",
    sourceEnvelope: {
      schema_version: 1,
      timestamp: "2026-09-06T10:00:00.000Z",
      tenant_id: "local",
      category: "runtime",
      type: "workflow.step.completed",
      run_id: "run-1",
      root_run_id: "run-1",
      level_id: "draft",
      payload: { step_id: "draft" },
    },
  },
];

/** What the approval endpoint hands back: the task it admitted. */
const admittedTask = (): SessionTask => ({
  id: TASK_ID,
  sessionId: SESSION_ID,
  runId: "run-1",
  workflowId: "wf-1",
  brief: "Draft and finalise the note.",
  status: "queued",
  createdAt: "2026-09-06T10:00:00.000Z",
  updatedAt: "2026-09-06T10:00:02.000Z",
  cwd: "/tmp/task-1",
});

const waitingTask = (): TaskRunEntry => ({
  taskId: TASK_ID,
  runId: "run-1",
  label: "Recovery task",
  mode: "awaiting_model_choice",
});

/**
 * The pane's real clients, over an exactly routed `fetch`.
 *
 * Not a stand-in for the session client: this test is about which endpoint the
 * approval reaches and what it sends, and a replaced client module could not
 * show either. Every endpoint the pane touches is declared; an unrouted URL
 * throws, so a test can never pass because some other request quietly answered
 * offer-shaped JSON.
 */
interface RecordedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
  readonly signal: AbortSignal | undefined;
}

const requests: RecordedRequest[] = [];
/**
 * Requests that matched no declared route.
 *
 * Recorded as well as thrown: production code catches its own read failures and
 * turns them into an on-screen message, so a throw alone could be absorbed and
 * leave a test passing against an endpoint nobody declared.
 */
const unrouted: string[] = [];
let routes = new Map<string, () => Promise<Response>>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const modelChoicePath = (sessionId: string): string =>
  `/api/sessions/${sessionId}/tasks/${TASK_ID}/model-choice`;

function route(
  method: string,
  pathname: string,
  handler: () => Promise<Response>,
): void {
  routes.set(`${method} ${pathname}`, handler);
}

function installRoutedFetch(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    requests.push({
      method,
      pathname: url.pathname,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      signal: init?.signal ?? undefined,
    });
    const handler = routes.get(`${method} ${url.pathname}`);
    if (!handler) {
      unrouted.push(`${method} ${url.pathname}`);
      throw new Error(`Unrouted request: ${method} ${url.pathname}`);
    }
    return handler();
  });
}

function requestsTo(method: string, pathname: string): RecordedRequest[] {
  return requests.filter(
    (request) => request.method === method && request.pathname === pathname,
  );
}

function modelChoiceRequests(method: string): RecordedRequest[] {
  return requestsTo(method, modelChoicePath(SESSION_ID));
}

/**
 * A response whose body-read is observable.
 *
 * `parsed` resolves when the client has actually decoded this response, which
 * is the boundary after which the panel's own continuation runs. Waiting on it
 * is a fact about the code under test rather than a guess at how long it takes.
 */
function observableJson(
  body: unknown,
  status = 200,
): { response: Response; parsed: Promise<void> } {
  let seen = (): void => undefined;
  const parsed = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const response = jsonResponse(body, status);
  const decode = response.json.bind(response);
  Object.defineProperty(response, "json", {
    value: async () => {
      const payload: unknown = await decode();
      seen();
      return payload;
    },
  });
  return { response, parsed };
}

function renderPane(onModelChoiceApproved?: (task: SessionTask) => void) {
  return render(
    <TaskBody
      task={waitingTask()}
      sessionId={SESSION_ID}
      events={completedPredecessor}
      onModelChoiceApproved={onModelChoiceApproved}
    />,
  );
}

/** The acceptance bodies actually put on the wire. */
function approvalBodies(): unknown[] {
  return modelChoiceRequests("POST").map((request) => request.body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("TaskBody awaiting_model_choice", () => {
  beforeEach(() => {
    requests.length = 0;
    unrouted.length = 0;
    routes = new Map();
    route("GET", modelChoicePath(SESSION_ID), () =>
      Promise.resolve(
        jsonResponse({ workflowRevision: 4, stepId: "finalize", offer }),
      ),
    );
    route("POST", modelChoicePath(SESSION_ID), () =>
      Promise.resolve(
        jsonResponse({ task: admittedTask(), stepId: "finalize" }, 202),
      ),
    );
    route("GET", "/api/workflows/wf-1", () =>
      Promise.resolve(jsonResponse({ stages: [] })),
    );
    route("GET", "/api/runs/run-1/diagnostics", () =>
      Promise.resolve(
        jsonResponse({
          bashRisks: [],
          delegations: { lifecycle: [], state: {} },
          mcp: { audit: [], toolResults: [] },
          transcript: { canonical: [], raw: [] },
        }),
      ),
    );
    installRoutedFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    expect(unrouted).toEqual([]);
  });

  it("states the agent, the pair that failed, the pair proposed, and that saved settings stay put", async () => {
    renderPane();
    const card = await screen.findByRole("note", { name: "Model choice" });
    expect(card).toHaveTextContent("Defaultrecoveryworker");
    expect(card).toHaveTextContent(
      "connection:absentconnection / fake/never-configured",
    );
    expect(card).toHaveTextContent("connection:present / fake/default");
    // True whichever way the provider is unusable, including a pinned CLI
    // that is not installed. "No usable credential" was false for that one.
    expect(card).toHaveTextContent("its provider is not ready");
    expect(card).toHaveTextContent("Its saved settings will not change.");
  });

  // The decision interrupts the run; it does not erase what the run already
  // did. A pane that hid the completed predecessor while asking about the next
  // step would make the question impossible to judge.
  it("keeps the run summary and process history on screen beside the decision", async () => {
    renderPane();
    await screen.findByRole("note", { name: "Model choice" });
    const timeline = screen.getByRole("region", { name: "Process timeline" });
    // The real timeline, rendering the predecessor that actually completed.
    expect(timeline).toHaveTextContent("Step draft completed");
    expect(timeline).not.toHaveTextContent(
      "Waiting for the workflow to report process events",
    );
  });

  it("reads the offer from this task, not from a chat turn or a human-input interaction", async () => {
    renderPane();
    await screen.findByRole("note", { name: "Model choice" });
    expect(modelChoiceRequests("GET")).toHaveLength(1);
  });

  it("approves through the task endpoint carrying only the offer identity and a key", async () => {
    renderPane();
    await screen.findByRole("note", { name: "Model choice" });
    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));

    await waitFor(() => expect(modelChoiceRequests("POST")).toHaveLength(1));
    expect(
      modelChoiceRequests("POST").map((request) => request.pathname),
    ).toEqual([modelChoicePath(SESSION_ID)]);
    const [body] = approvalBodies();
    if (!isRecord(body)) throw new Error("The approval carried no JSON object");
    const { idempotencyKey, ...identity } = body;
    expect(identity).toEqual({ offerId: "offer-1" });
    expect(idempotencyKey).toMatch(/.+/);
  });

  it("admits one continuation from a double click", async () => {
    renderPane();
    await screen.findByRole("note", { name: "Model choice" });
    await userEvent.dblClick(
      screen.getByRole("button", { name: APPROVE_BUTTON }),
    );

    await waitFor(() => expect(modelChoiceRequests("POST")).toHaveLength(1));
    expect(modelChoiceRequests("POST")).toHaveLength(1);
  });

  it("clears the pending decision once the approval lands", async () => {
    renderPane();
    await screen.findByRole("note", { name: "Model choice" });
    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));

    await waitFor(() =>
      expect(
        screen.queryByRole("note", { name: "Model choice" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // The 202 already names the task the approval admitted. Handing it up is what
  // lets the pane adopt the continuation now instead of looking stopped until
  // the next status poll.
  it("hands the admitted task to the pane so the continuation is adopted at once", async () => {
    const onModelChoiceApproved = vi.fn();
    renderPane(onModelChoiceApproved);
    await screen.findByRole("note", { name: "Model choice" });
    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));

    await waitFor(() => expect(onModelChoiceApproved).toHaveBeenCalledTimes(1));
    expect(onModelChoiceApproved).toHaveBeenCalledWith(admittedTask());
  });

  it("tells the pane nothing when the approval is refused", async () => {
    route("POST", modelChoicePath(SESSION_ID), () =>
      Promise.resolve(jsonResponse({ error: "stale-revision" }, 409)),
    );
    const onModelChoiceApproved = vi.fn();
    renderPane(onModelChoiceApproved);
    await screen.findByRole("note", { name: "Model choice" });
    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "stale-revision",
    );
    expect(onModelChoiceApproved).not.toHaveBeenCalled();
  });

  // A refused approval leaves the run exactly where it was, so the offer has to
  // stay on screen. Retrying reuses the same key: a second key would let one
  // decision be admitted twice.
  it("keeps the offer and reuses the same key when an approval is refused", async () => {
    let approvals = 0;
    route("POST", modelChoicePath(SESSION_ID), () => {
      approvals += 1;
      return Promise.resolve(
        approvals === 1
          ? jsonResponse({ error: "claim-unavailable" }, 409)
          : jsonResponse({ task: admittedTask(), stepId: "finalize" }, 202),
      );
    });
    renderPane();
    await screen.findByRole("note", { name: "Model choice" });
    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "claim-unavailable",
    );
    expect(
      screen.getByRole("note", { name: "Model choice" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));
    await waitFor(() => expect(modelChoiceRequests("POST")).toHaveLength(2));
    const bodies = approvalBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
  });

  // Leaving the pane abandons the wait, but the server may already have
  // committed the approval and no abort can undo that. So the answer can still
  // arrive; what must not happen is it being applied to whatever is there now.
  it("ignores an approval that lands after its pane is gone", async () => {
    let settle: (value: Response) => void = () => undefined;
    route(
      "POST",
      modelChoicePath(SESSION_ID),
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    const onModelChoiceApproved = vi.fn();
    const { unmount } = renderPane(onModelChoiceApproved);
    await screen.findByRole("note", { name: "Model choice" });
    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));
    await waitFor(() => expect(modelChoiceRequests("POST")).toHaveLength(1));

    unmount();
    const late = observableJson(
      { task: admittedTask(), stepId: "finalize" },
      202,
    );
    settle(late.response);
    // Waited on the client actually decoding the body, which is the boundary
    // after which the panel's own continuation would run.
    await act(async () => {
      await late.parsed;
    });

    expect(onModelChoiceApproved).not.toHaveBeenCalled();
  });

  // A session switch can leave the same task entry mounted for one render. The
  // offer, its idempotency key and the endpoint it was fetched from all belong
  // to the session it came from, so the pane must start again rather than show
  // the old decision under the new session's endpoint.
  it("drops the old decision when the session changes under it", async () => {
    const otherSession = "sess-2";
    const otherOffer = {
      ...offer,
      offerId: "offer-2",
      scope: { ...offer.scope, sessionId: otherSession },
    };
    let settleOldPost: (value: Response) => void = () => undefined;
    let releaseNewRead: (value: Response) => void = () => undefined;
    route(
      "POST",
      modelChoicePath(SESSION_ID),
      () =>
        new Promise<Response>((resolve) => {
          settleOldPost = resolve;
        }),
    );
    // Held, so the blank pane below is the switch itself and not a race with
    // the new session's read arriving.
    route(
      "GET",
      modelChoicePath(otherSession),
      () =>
        new Promise<Response>((resolve) => {
          releaseNewRead = resolve;
        }),
    );
    route("POST", modelChoicePath(otherSession), () =>
      Promise.resolve(
        jsonResponse(
          {
            task: { ...admittedTask(), sessionId: otherSession },
            stepId: "finalize",
          },
          202,
        ),
      ),
    );

    const keys = ["key-a", "key-b"];
    let issued = 0;
    const onModelChoiceApproved = vi.fn();
    const paneFor = (sessionId: string) => (
      <TaskBody
        task={waitingTask()}
        sessionId={sessionId}
        events={completedPredecessor}
        onModelChoiceApproved={onModelChoiceApproved}
        newIdempotencyKey={() => keys[issued++] ?? "key-overflow"}
      />
    );
    const { rerender } = render(paneFor(SESSION_ID));
    await screen.findByRole("note", { name: "Model choice" });
    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));
    await waitFor(() => expect(modelChoiceRequests("POST")).toHaveLength(1));
    const abandoned = modelChoiceRequests("POST")[0];

    rerender(paneFor(otherSession));

    // The old decision is gone at once, while the new read is still held.
    expect(
      screen.queryByRole("note", { name: "Model choice" }),
    ).not.toBeInTheDocument();
    // And the wait it belonged to is abandoned.
    expect(abandoned?.signal?.aborted).toBe(true);

    // Resolving the abandoned approval reaches nothing.
    const late = observableJson(
      { task: admittedTask(), stepId: "finalize" },
      202,
    );
    settleOldPost(late.response);
    await act(async () => {
      await late.parsed;
    });
    expect(onModelChoiceApproved).not.toHaveBeenCalled();

    // The new session is read on its own endpoint, and approves on its own key.
    await act(async () => {
      releaseNewRead(
        jsonResponse({
          workflowRevision: 9,
          stepId: "finalize",
          offer: otherOffer,
        }),
      );
    });
    await screen.findByRole("note", { name: "Model choice" });
    expect(requestsTo("GET", modelChoicePath(otherSession))).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));
    await waitFor(() => expect(onModelChoiceApproved).toHaveBeenCalledTimes(1));
    expect(onModelChoiceApproved.mock.calls[0]?.[0]).toMatchObject({
      sessionId: otherSession,
    });
    expect(
      requestsTo("POST", modelChoicePath(otherSession)).map(
        (request) =>
          (request.body as { idempotencyKey?: string }).idempotencyKey,
      ),
    ).toEqual(["key-b"]);
    expect(
      (abandoned?.body as { idempotencyKey?: string } | undefined)
        ?.idempotencyKey,
    ).toBe("key-a");
  });

  it("says so plainly when the offer cannot be read", async () => {
    route("GET", modelChoicePath(SESSION_ID), () =>
      Promise.resolve(jsonResponse({ error: "offer unreadable" }, 500)),
    );
    renderPane();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "offer unreadable",
    );
  });

  // The task's own status says it is waiting on a decision. If the offer then
  // reads as absent, something is wrong — and a blank pane would leave the
  // person waiting on a question that never appears.
  it("does not go blank when the task is waiting but no offer comes back", async () => {
    route("GET", modelChoicePath(SESSION_ID), () =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    renderPane();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This task is waiting on a model choice, but the decision could not be read.",
    );
  });

  it("abandons the read when the pane goes away", async () => {
    const { unmount } = renderPane();
    await screen.findByRole("note", { name: "Model choice" });
    const read = modelChoiceRequests("GET")[0];
    expect(read?.signal?.aborted).toBe(false);
    unmount();
    expect(read?.signal?.aborted).toBe(true);
  });

  it("sends the idempotency key its injected factory produced", async () => {
    const keys: string[] = [];
    render(
      <TaskBody
        task={waitingTask()}
        sessionId={SESSION_ID}
        events={completedPredecessor}
        newIdempotencyKey={() => {
          const key = `key-${keys.length}`;
          keys.push(key);
          return key;
        }}
      />,
    );
    await screen.findByRole("note", { name: "Model choice" });
    await userEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));

    await waitFor(() => expect(modelChoiceRequests("POST")).toHaveLength(1));
    expect(approvalBodies()[0]).toEqual({
      offerId: "offer-1",
      idempotencyKey: "key-0",
    });
  });
});
