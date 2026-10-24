import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderCatalogProvider } from "@/contexts/provider-catalog-context";
import AgentsAndTeamsPanel from "../agents-and-teams-panel";
import { useResourceArchitectChat } from "../use-resource-architect-chat";

const model = { provider: "openai", model: "fixture" };
const revision = `sha256:${"a".repeat(64)}`;
const nextRevision = `sha256:${"b".repeat(64)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
function plan(id = "plan-1", enabled = true) {
  return { id, kind: "standalone_agents" as const, agents: [{ name: "product-reviewer", role: "Reviewer", description: "Reviews current products.", rationale: "Needs current sources.", webResearchEnabled: enabled }] };
}
function snapshot(id = "plan-1", enabled = true, value = revision) {
  return { planId: id, plan: plan(id, enabled), revision: value };
}
function meta() {
  return { ...model, fallback: false, reasoning: "low", timing: {
    contextAssemblyMs: 0, providerDurationMs: 0, processSpawnMs: null, firstProviderEventMs: null, firstTextMs: null,
    parseDurationMs: 0, repairOccurred: false, repairDurationMs: 0, totalDurationMs: 0,
    context: { instructionsChars: 0, operationChars: 0, uploadedDocumentPolicyChars: 0, visualizationPolicyChars: 0, teamLibraryChars: 0, agentLibraryChars: 0, totalChars: 0, historyChars: 0 },
  } };
}

// The HTTP service and paid Architect are unavailable in this component suite.
// Only fetch is replaced; the panel, hook, contracts and clients remain real.
function server(options: {
  read?: (id: string, count: number) => Response | Promise<Response>;
  amend?: () => Response | Promise<Response>;
} = {}) {
  const writes: { path: string; body: unknown }[] = [];
  let proposals = 0;
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    if (method === "POST") writes.push({ path, body: JSON.parse(String(init?.body ?? "null")) });
    if (path.endsWith("/settings/model-catalog")) return json({ catalog: [{ provider: "openai", label: "OpenAI", models: [{ id: "fixture", label: "Fixture" }] }], defaultModel: model, defaultModelState: { status: "set", selection: model } });
    if (path.endsWith("/create/chat-defaults")) return json({ team: model });
    if (path.endsWith("/resource-architect/turn")) {
      if (method === "GET") return new Response(null, { status: 404 });
      proposals += 1;
      return json({ jobId: `proposal-${proposals}`, operation: "proposal", message: "Proposal ready.", warnings: [], outcome: plan(`plan-${proposals}`), meta: meta() });
    }
    const read = /\/plans\/([^/]+)\/shape$/.exec(path);
    if (read) { reads += 1; return options.read?.(read[1] ?? "", reads) ?? json(snapshot(read[1])); }
    if (path.endsWith("/web-research")) return options.amend?.() ?? json(snapshot("plan-1", false, nextRevision));
    if (path.endsWith("/resource-architect/jobs")) {
      return method === "GET" ? json({ jobs: [] }) : json({ jobId: "build", job: { jobId: "build", planId: "plan-1", status: "completed", items: [], events: [], selectedResource: null } }, 202);
    }
    if (path.endsWith("/resource-architect/metrics")) return json({ metrics: [] });
    if (path.endsWith("/files")) return json({ files: [] });
    return json([]);
  }));
  return { writes, builds: () => writes.filter((write) => write.path.endsWith("/resource-architect/jobs")) };
}
function hook() {
  return renderHook(() => useResourceArchitectChat({ model }));
}
async function propose(result: ReturnType<typeof hook>["result"]) {
  await act(async () => { await result.current.submit("Create a product reviewer"); });
}
async function showPanel() {
  render(<ProviderCatalogProvider><AgentsAndTeamsPanel /></ProviderCatalogProvider>);
  const input = await screen.findByPlaceholderText("Describe the Agents or Team you need…");
  await waitFor(() => expect(input).toBeEnabled());
  await userEvent.type(input, "Create a product reviewer");
  await userEvent.click(screen.getByRole("button", { name: "Submit" }));
  return screen.findByLabelText("Agent product-reviewer", { selector: "[data-slot=card]" });
}
afterEach(() => vi.unstubAllGlobals());

it("blocks standalone creation until its revision arrives, then submits that revision", async () => {
  const read = deferred<Response>();
  const api = server({ read: () => read.promise });
  const { result } = hook();
  await propose(result);
  await act(async () => { await result.current.createPlan(); });
  expect(api.builds()).toEqual([]);
  await act(async () => { read.resolve(json(snapshot())); });
  await waitFor(() => expect(result.current.planRevision).toBe(revision));
  await act(async () => { await result.current.createPlan(); });
  expect(api.builds()[0]?.body).toMatchObject({ planId: "plan-1", expectedRevision: revision });
});

it("prevents competing amendments and creation while internet access is saving", async () => {
  const amendment = deferred<Response>();
  const api = server({ amend: () => amendment.promise });
  const { result } = hook();
  await propose(result);
  await waitFor(() => expect(result.current.canChangeShape).toBe(true));
  let saving: Promise<unknown> | undefined;
  act(() => { saving = result.current.changeWebResearch("product-reviewer", false); });
  await act(async () => {
    await result.current.changeWebResearch("product-reviewer", true);
    await result.current.createPlan();
  });
  expect(api.writes.filter((write) => write.path.endsWith("/web-research"))).toHaveLength(1);
  expect(api.builds()).toEqual([]);
  await act(async () => { amendment.resolve(json(snapshot("plan-1", false, nextRevision))); await saving; });
  expect(result.current.pendingPlan).toEqual(plan("plan-1", false));
  await act(async () => { await result.current.createPlan(); });
  expect(api.builds()[0]?.body).toMatchObject({ expectedRevision: nextRevision });
});

it("keeps the proposal's card summary through an accepted internet access change", async () => {
  const summary = "Checks current product prices against named sources.";
  const withSummary = (enabled: boolean) => {
    const current = plan("plan-1", enabled);
    return { ...current, agents: current.agents.map((agent) => ({ ...agent, summary })) };
  };
  server({ amend: () => json({ planId: "plan-1", plan: withSummary(false), revision: nextRevision }) });
  const { result } = hook();
  await propose(result);
  await waitFor(() => expect(result.current.canChangeShape).toBe(true));

  await act(async () => { await result.current.changeWebResearch("product-reviewer", false); });

  expect(result.current.pendingPlan).toEqual(withSummary(false));
  expect(result.current.planRevision).toBe(nextRevision);
});

it("returns conflicts as card notices and leaves the chat error clear", async () => {
  server({ amend: () => json({ ...snapshot("plan-1", false, nextRevision), reason: "This proposal changed. Review its current settings." }, 409) });
  const { result } = hook();
  await propose(result);
  await waitFor(() => expect(result.current.canChangeShape).toBe(true));
  let notice: unknown;
  await act(async () => { notice = await result.current.changeWebResearch("product-reviewer", false); });
  expect(notice).toBe("This proposal changed. Review its current settings.");
  expect(result.current.error).toBeNull();
  expect(result.current.pendingPlan).toEqual(plan("plan-1", false));
});

it("discards an amendment after another proposal replaces its card", async () => {
  const amendment = deferred<Response>();
  server({ amend: () => amendment.promise });
  const { result } = hook();
  await propose(result);
  await waitFor(() => expect(result.current.canChangeShape).toBe(true));
  let saving: Promise<unknown> | undefined;
  act(() => { saving = result.current.changeWebResearch("product-reviewer", false); });
  await propose(result);
  await act(async () => { amendment.resolve(json(snapshot("plan-1", false))); await saving; });
  expect(result.current.pendingPlan).toEqual(plan("plan-2"));
  expect(result.current.canChangeShape).toBe(true);
  expect(result.current.error).toBeNull();
});

it("retains admission discovered while an earlier amendment is still pending", async () => {
  const amendment = deferred<Response>();
  server({ amend: () => amendment.promise, read: (_id, count) => json({ ...snapshot(), ...(count > 1 ? { admitted: { jobId: "build", revision } } : {}) }) });
  const { result } = hook();
  await propose(result);
  await waitFor(() => expect(result.current.canChangeShape).toBe(true));
  let saving: Promise<unknown> | undefined;
  act(() => { saving = result.current.changeWebResearch("product-reviewer", false); });
  act(() => result.current.retryShapeRead());
  await waitFor(() => expect(result.current.planAdmitted).toEqual({ jobId: "build", revision }));
  await act(async () => { amendment.resolve(json(snapshot("plan-1", false, nextRevision))); await saving; });
  expect(result.current.planAdmitted).toEqual({ jobId: "build", revision });
  expect(result.current.canChangeShape).toBe(false);
});

it("recovers a standalone card after a failed revision read", async () => {
  const first = deferred<Response>();
  server({ read: (_id, count) => count === 1 ? first.promise : json(snapshot()) });
  const card = await showPanel();
  expect(within(card).getByRole("button", { name: "Create" })).toBeDisabled();
  await act(async () => { first.resolve(new Response("offline", { status: 503 })); });
  await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() => expect(within(card).getByRole("button", { name: "Create" })).toBeEnabled());
  expect(within(card).getByRole("switch")).toBeChecked();
});

it("shows a refused internet choice beside the switch on its card", async () => {
  server({ amend: () => json({ ...snapshot(), reason: "This proposal changed. Review its current settings." }, 409) });
  const card = await showPanel();
  await waitFor(() => expect(within(card).getByRole("switch")).toBeEnabled());
  await userEvent.click(within(card).getByRole("switch"));
  expect(await within(card).findByText("This proposal changed. Review its current settings.")).toBeVisible();
});

it("shows an HTTP error rather than a JSON parser exception when saving fails", async () => {
  server({ amend: () => new Response("<html>Unavailable</html>", { status: 503, statusText: "Service Unavailable" }) });
  const { result } = hook();
  await propose(result);
  await waitFor(() => expect(result.current.canChangeShape).toBe(true));
  let notice: unknown;
  await act(async () => { notice = await result.current.changeWebResearch("product-reviewer", false); });
  expect(notice).toContain("503 Service Unavailable");
  expect(result.current.error).toBeNull();
  expect(result.current.pendingPlan).toEqual(plan());
});
