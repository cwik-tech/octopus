# Business workflow: chat-confirmed workflow launch

## Scope and starting conditions

A Run session conversation: either the General Agent (front door) answering
untargeted turns, or the Coordinator planning mode when a Workflow the user
selected governs the session. This document covers starting a Workflow from a
chat confirmation — the user saying "go for it" after a proposal. The Begin
workflow button, explicit Workflow targets, Team dispatch, and Deep Research
intake are covered elsewhere or by their existing tests; this flow interacts
with them but does not redefine them.

## Flow

```mermaid
flowchart TD
    A[User request] --> B[Front door proposes a Workflow in prose]
    B --> C[User confirms in chat: "go for it"]
    C --> D{start_workflow tool call?}
    D -->|unknown or invalid id| E[Refusal names the registered workflows; nothing persisted]
    D -->|plan not ready| F[Plan persisted as needs_input; refusal lists what is missing; agent asks]
    D -->|ready| G[Plan built or reused; applyRunPlanService admits one task]
    G --> H[Reply reports the start; dispatch response carries task and plan]
    G --> I[A repeated confirmation observes the same task]
```

1. The front door answers and, when one registered Workflow fits, proposes it
   in prose, closing with an invitation to confirm in chat.
2. The user replies with an unambiguous confirmation ("go for it", "start",
   "yes, run it") carrying no new requirements.
3. The General Agent calls the turn-scoped `start_workflow` tool with the exact
   registered workflow id.
4. The tool first checks the proposal invariant: the conversation must contain
   durable evidence that this Workflow was proposed — either the persisted run
   plan already selects it (a Coordinator planning turn's selection), or an
   earlier assistant message names its exact id (the front door names it by
   rule). The user naming an id is a request, not a proposal. Without evidence
   the call is refused and nothing is persisted.
5. The tool reuses the session's persisted plan when it already selects that
   Workflow and is ready (or active), or builds one from the conversation as
   the user's own selection. A different persisted Workflow selection refuses
   the older proposal. New plans compare-and-set against the observed plan id
   (or absence), preserving another window's intervening selection. A plan still missing details is persisted as
   `needs_input` and does not launch: the refusal lists the missing inputs so
   the agent asks for them.
6. A ready plan launches through the same admission service the Begin workflow
   route uses, including its Model Context Protocol (MCP) tool-prerequisite preflight — a workflow whose
   required capabilities are unavailable is refused before admission and the
   plan stays ready. Deep Research approval is still enforced there; a plan
   whose research proposal is unapproved or changed refuses with that reason.
   The turn's selected project context is sealed into the admitted task, and
   results the user carried into the turn are folded into its brief. The concrete
   provider/model used by the confirming chat turn is sealed as `workerModel` on
   the task and in tool preflight. All ordinary and delegated workers use that
   selection for this task, including recovery. Saved agent files remain unchanged;
   tasks without this field keep their existing selection rules.
7. The reply may report the start only because the tool confirmed it. The
   dispatch response carries the launched task and plan on every branch that
   can launch (agents, coordinator, workflow), and the chat panel hands them
   to the same handlers a Team dispatch uses, so the run appears immediately.
8. An exact retry of the confirmation turn — a dropped response, or a crash
   after admission but before the reply was saved — recovers the admitted task
   and plan from the task's recorded source turn. It never calls the provider
   and never launches again.

The Coordinator planning path expresses the same intent structurally: the
receptionist's `launchIntent` may be `"start"` only for an unchanged, ready
plan the latest message unambiguously confirms; the turn then preserves the
existing plan (rather than replanning around "go for it") and launches it
after the revision is persisted.

The proposal invariant accepts two forms of evidence (rule CWL-18), chosen
over a stricter "assistant prose only" rule because the Coordinator planning
path proposes by *selecting*: its persisted plan records the choice with no
requirement that any message name the id, and front-door turns must be able to
confirm such a plan. The assistant-mention form covers the front door's prose
proposals, whose rules require the exact registered id to be named. Both forms
are durable facts the server wrote, so the check survives reloads and never
depends on model wording.

## Alternative flows

- A bare "start" with no prior proposal launches nothing. Language judgment
  stays with the model, but the tool enforces the structural half server-side:
  no persisted plan selection and no assistant message naming the id means a
  `no_proposal` refusal before any plan is persisted. The Coordinator's
  server-side gate likewise refuses a `start` whose selection was made in the
  same turn.
- A confirmation adding new requirements, a question, or a conditional is not
  a confirmation; no tool call is made and the turn answers normally.
- Two confirmations of the same ready plan produce one task through idempotent
  admission. When both must create a plan, a changed observed plan refuses with
  `conflict`; the user can confirm the current selection again.
- The task queue still recovering when a confirmation arrives refuses the
  launch without failing the turn; the plan stays ready and the user can
  confirm again.
- A replayed or superseded turn does not relaunch: the durable plan and the
  task's recorded source turn identify the one admission.

## Business rules and test mapping

| ID | Required outcome | Test boundary and reason | Test file and exact name |
| --- | --- | --- | --- |
| CWL-01 | A chat confirmation of a proposed workflow launches it and the dispatch response carries the task and plan. | End-to-end over the real API server, session store, and admission queue; the provider is stubbed at HTTP because it is paid and non-deterministic. | [chat-confirmed-workflow-launch.test.ts](../../tests/integration/chat-confirmed-workflow-launch.test.ts), "a chat confirmation of a proposed workflow launches it" |
| CWL-02 | A bare "start" with no prior proposal launches nothing. | Same boundary: wiring must not launch without a tool call. | [chat-confirmed-workflow-launch.test.ts](../../tests/integration/chat-confirmed-workflow-launch.test.ts), "a bare start with no prior proposal launches nothing" |
| CWL-03 | Unknown or invalid workflow ids are refused and persist nothing. | Adapter against the real store, registry, and queue; the tool's own contract. | [workflow-launch-tool-adapter.test.ts](../../tests/integration/workflow-launch-tool-adapter.test.ts), "an unknown workflow id is refused and persists nothing" |
| CWL-04 | A not-ready plan does not launch; the refusal lists what is missing and the plan persists as the user's selection. | Same boundary. | [workflow-launch-tool-adapter.test.ts](../../tests/integration/workflow-launch-tool-adapter.test.ts), "a thin conversation produces no launch and says what is missing" |
| CWL-05 | A ready plan launches and reports the task; the task records the confirming turn. | Same boundary. | [workflow-launch-tool-adapter.test.ts](../../tests/integration/workflow-launch-tool-adapter.test.ts), "a confirmation with substance behind it launches and reports the task" |
| CWL-06 | A repeated or concurrent confirmation starts one task and every call observes it. | Same boundary, concurrent and sequential duplicate calls. | [workflow-launch-tool-adapter.test.ts](../../tests/integration/workflow-launch-tool-adapter.test.ts), "a repeated call in the same turn reports the same task instead of launching twice"; [session-task-api-contract.test.ts](../../tests/integration/session-task-api-contract.test.ts), "concurrent chat confirmations create exactly one task" |
| CWL-07 | Admission still recovering refuses without claiming a start; the plan stays ready. | Same boundary with an uninitialized queue. | [workflow-launch-tool-adapter.test.ts](../../tests/integration/workflow-launch-tool-adapter.test.ts), "a confirmation while admission is recovering refuses without claiming a start" |
| CWL-08 | The Coordinator's start gate launches an unchanged ready plan on an unambiguous confirmation, in any language; the reply says the workflow is starting. | Full API with a scripted structured model; the launch decision is structural, not prose parsing. | [session-task-api-contract.test.ts](../../tests/integration/session-task-api-contract.test.ts), "an arbitrary-language chat confirmation launches the persisted ready plan", "a chat confirmation starts a ready workflow without the Begin workflow action", "a repaired structured start decision still launches a ready plan" |
| CWL-09 | A first request that asks to start does not launch, even when the model claims start intent. | Same boundary; the server, not the model, is the gate. | [session-task-api-contract.test.ts](../../tests/integration/session-task-api-contract.test.ts), "a first request that asks to start does not launch, even when the model claims start intent" |
| CWL-10 | An incomplete brief cannot be bypassed by start language. | Same boundary. | [session-task-api-contract.test.ts](../../tests/integration/session-task-api-contract.test.ts), "chat start language cannot bypass an incomplete authoritative brief" |
| CWL-11 | A start turn preserves the ready plan it confirms instead of replanning around the confirmation text. | Unit predicate. | [session-service.test.ts](../../tests/unit/session-service.test.ts), "chat Start preserves any ready plan for the workflow it names" |
| CWL-12 | The `launchIntent` gate lives in the code-owned envelope; a persona cannot rewrite it. | Unit prompt assembly. | [front-door-planning-mode.test.ts](../../tests/unit/front-door-planning-mode.test.ts), "a persona cannot rewrite the launchIntent gate by editing its planning section" |
| CWL-13 | The chat panel reports a front-door-launched task and plan to the same handlers a Team dispatch uses; a plain agents reply reports neither. | UI component test with the session client mocked; the wiring, not the launch, is what is proven. | [chat-panel-keyboard.test.tsx](../../ui/src/components/run/chat/__tests__/chat-panel-keyboard.test.tsx), "reports the task a front-door chat confirmation launched" and "does not report a task when an agents reply did not launch one" |
| CWL-14 | A chat-confirmed launch runs the same MCP tool-prerequisite preflight as Begin workflow; unavailable required capabilities refuse before admission and take no apply claim. | End-to-end over the real API and the composition's real preflight service, with no MCP servers configured. | [chat-confirmed-workflow-launch.test.ts](../../tests/integration/chat-confirmed-workflow-launch.test.ts), "a chat-confirmed launch of a workflow with unavailable tool prerequisites is refused before admission" |
| CWL-15 | The turn's selected project context is sealed into the admitted task's brief and plan, and carried results are folded into the brief. | Same HTTP boundary for the project selection; the adapter boundary for carried results. | [chat-confirmed-workflow-launch.test.ts](../../tests/integration/chat-confirmed-workflow-launch.test.ts), "a chat-confirmed launch seals the selected project context into the admitted task"; [workflow-launch-tool-adapter.test.ts](../../tests/integration/workflow-launch-tool-adapter.test.ts), "a launch folds the turn's carried results into the admitted task brief" |
| CWL-16 | An exact replay of a confirmation turn reports the task and plan it launched without calling the provider; a turn whose reply was lost after admission recovers both on retry. | HTTP replay with a fixed turn id; an HTTP crash window where the assistant write fails after admission. | [chat-confirmed-workflow-launch.test.ts](../../tests/integration/chat-confirmed-workflow-launch.test.ts), "a chat confirmation of a proposed workflow launches it" (replay assertions) and "a turn that lost its reply after admission recovers the launched task on retry" |
| CWL-17 | Coordinator and workflow dispatch responses carry the launched task; the planning chat hands it to the task-started handler. | API contract assertion plus the UI component test. | [session-task-api-contract.test.ts](../../tests/integration/session-task-api-contract.test.ts), "a chat confirmation starts a ready workflow without the Begin workflow action" (response task assertions); [chat-panel-keyboard.test.tsx](../../ui/src/components/run/chat/__tests__/chat-panel-keyboard.test.tsx), "reports the task a coordinator chat confirmation launched" |
| CWL-18 | The tool launches only a Workflow the conversation proposed: a persisted plan selecting it, or an assistant message naming its exact id. A user naming the id is not evidence. | Adapter boundary; the model is not involved, so the refusal is structural. | [workflow-launch-tool-adapter.test.ts](../../tests/integration/workflow-launch-tool-adapter.test.ts), "a tool call without any prior proposal is refused and admits nothing", "a user message naming the workflow is not proposal evidence", "a persisted plan selecting the workflow is proposal evidence without an assistant mention" |
| CWL-19 | An older proposal cannot replace a different selection; creating a plan refuses if the observed plan changed. | Adapter refusal and filesystem-backed plan service compare-and-set. | `tests/integration/workflow-launch-tool-adapter.test.ts`, "an older proposal cannot replace a different selected workflow" and "plan creation refuses when another window selected a plan after the observed empty state" |
| CWL-20 | Shared turn wiring preserves the registry path for approved model retries. | Public composition contract; this checks forwarding, not the model's use of the tool. | `tests/integration/workflow-launch-tool-adapter.test.ts`, "shared turn wiring retains the workflow registry for approved retries" |
| CWL-21 | Chat confirmation displays the admitted Workflow run in the desktop conversation without pressing Begin. | Electron renderer, real API, filesystem and admission; deterministic local model endpoint. | `tests/electron/unified-run-chat-workflow-dispatch.spec.ts`, "confirming a proposed Workflow in chat displays its admitted run" |
| CWL-23 | A chat-confirmed Workflow retains the chat's concrete model across task persistence, launch transport, nested workers and tool preflight, overriding saved Agent pairs for that task only. | Real API/store/admission plus worker loading; Electron checks a saved Claude worker reaches the selected local provider. | `tests/integration/chat-confirmed-workflow-launch.test.ts`, "a confirmed workflow persists and launches with the chat model instead of the saved worker pair"; `tests/unit/load-agent.test.ts`, "a chat-selected workflow model overrides a saved agent pair", "a chat-selected workflow model overrides a saved team pair"; `tests/unit/workflow-model-selection.test.ts`; `tests/electron/unified-run-chat-workflow-dispatch.spec.ts`, "confirming a proposed Workflow in chat displays its admitted run" |
| CWL-22 | A blocked child worker's normalized provider quota reason reaches one persisted chat outcome without raw stderr, including after reopening the store. | Pure formatter and real filesystem task publication. | `tests/unit/task-outcome-chat-message.test.ts`, "a blocked worker exposes its safe provider quota reason without child stderr", "a quota phrase inside stderr cannot replace the actual child failure"; `tests/integration/session-task-recovery-contract.test.ts`, "a child provider quota becomes one safe persisted chat outcome" |

A blocked child worker with a normalized provider usage-limit reason publishes
that reason in the task's chat outcome. Only a known provider name and static
recovery guidance are displayed; raw child stderr stays outside the transcript.
Browser acquisition budgets are separate from worker model selection; see
[cloud-browser limits](../reference/cloud-browser-limits.md).

A workflow worker stays visible after its end event while the saved transcript
is loading. Its status changes to "Finishing the workflow" and the persisted
outcome or delivery replaces it, including a child run that ends incomplete
because expected artifacts are missing. Cancellation and input/model-choice
waits clear finishing activity so the existing attention controls take over.
Failed and blocked terminal events request a transcript refresh immediately. The launching
assistant's pending or streamed reply appears before worker activity.

| ID | Required outcome | Test boundary and reason | Test file and exact name |
| --- | --- | --- | --- |
| CWL-24 | The worker does not disappear between its end event and the saved outcome or delivery. | Event projection and chat component, paired with real Electron/API/filesystem and a delayed transcript response. | `ui/src/lib/utils/__tests__/workflow-chat-events.test.ts`, "keeps the completed workflow worker visible while the task outcome is loading"; `ui/src/components/run/chat/__tests__/chat-panel-keyboard.test.tsx`, "keeps the extractor visible until its persisted workflow outcome replaces it"; `tests/electron/unified-run-chat-workflow-dispatch.spec.ts`, "confirming a proposed Workflow in chat displays its admitted run" |
| CWL-25 | Failed and blocked tasks immediately request their saved chat outcome. | Task event-stream boundary. | `ui/src/components/run/tasks/__tests__/use-task-event-stream.test.tsx`, "refreshes the persisted outcome immediately on run.failed" and "refreshes the persisted outcome immediately on run.blocked" |

For `youtube-manual-generation`, a YouTube extractor whose selected model
fails with a normalized quota or billing error before any tool dispatch can
continue once through the saved YouTube Gemini API model. The key and endpoint
stay in the parent process; worker requests cannot supply or redirect them.
The fallback uses the same granted tools and required capability groups. It
never restarts a turn after a tool starts, a resumed question continuation,
or a structured-output turn. An unavailable key or a failed Gemini attempt
ends recovery; there is no retry loop. Its result explains the switch and its
completion records Gemini as the actual provider. Old provider pricing is not
applied to Gemini; absent a configured Gemini price, cost remains untracked.
The tool loop preserves Gemini thought signatures on subsequent requests.

| ID | Required outcome | Test boundary and reason | Test file and exact name |
| --- | --- | --- | --- |
| CWL-26 | A YouTube worker quota failure before tools can complete once through saved Gemini; no restart after an effect, no other-workflow switch, and no loop when fallback is exhausted. | Real HTTP provider boundary and filesystem tool effect. | `tests/integration/youtube-worker-quota-fallback.test.ts`, "a quota failure before tools completes the YouTube worker through Gemini once", "a quota failure after a tool never replays the worker through Gemini", and the three "quota recovery stops safely" cases |
| CWL-27 | Gemini tool rounds retain thought signatures, and completion identifies the actual provider without inheriting Codex zero-cost or pricing settings. | Real HTTP round trip and worker client response. | `tests/integration/youtube-worker-quota-fallback.test.ts`, "Gemini fallback returns its thought signature on the next tool round"; `tests/integration/mcp-worker-turn-text-observer.test.ts`, "a Gemini fallback reports its actual provider instead of free Codex usage" |

## YouTube screenshot recovery

Media inspection requests only the size, duration and selected-format fields,
then downloads with the running bundled Node executable available for JavaScript
challenges. Process output is parsed after inherited pipes close. When playback
fails in the application browser, screenshot capture tries one separate headed
browser with a temporary profile, then closes it and removes the profile. The
original browser and its other assignments remain running. A capture already cancelled at the recovery decision does
not start another browser. Both failed attempts produce a bounded, contextual failure.

- `tests/integration/youtube-media-acquisition.test.ts`: "large unused video
  metadata does not prevent downloading the manual source" and "media download
  supplies the running Node runtime for YouTube JavaScript challenges".
- `tests/integration/youtube-process-output.test.ts`: "a media process returns
  its complete piped metadata after its parent exits" and "media subprocesses
  can launch the embedded Electron executable as Node".
- `tests/unit/youtube-browser-frame.test.ts`: "a failed YouTube frame capture
  recovers in an isolated headed browser without stopping existing work" and
  "a failed headed recovery stops after two browsers and removes its temporary
  profile". Puppeteer launch is substituted because Chrome is nondeterministic;
  the actual video recovery is separate live evidence in the status below.

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.
