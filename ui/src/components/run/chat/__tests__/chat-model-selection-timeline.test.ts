/**
 * Where a default-use notice belongs in the conversation.
 *
 * Directly under the question that started the turn, and derived from the
 * user message's own admitted-selection record rather than from any reply, so
 * it is on screen while the agent is still working and stays there afterwards.
 *
 * A pure projection, tested as one. The notice's markup is the component's
 * business; this is about which turn it belongs to and when it appears at all.
 */
import { expect, it } from "vitest";

import type { ModelSelectionRecord } from "@contracts/agent-model-selection";
import { buildConversationTimeline } from "@/lib/utils/chat-timeline";
import type { ChatMessage } from "@/lib/models/session-model";

function agentDefault(provider = "openai", model = "gpt-5"): ModelSelectionRecord {
  return {
    provider,
    model,
    source: "app-default",
    reason: "agent-default",
    caller: "agent",
  };
}

function explicitAgent(provider = "openai", model = "gpt-5"): ModelSelectionRecord {
  return {
    provider,
    model,
    source: "agent",
    reason: "explicit-agent-choice",
    caller: "agent",
  };
}

function userMessage(
  turnId: string,
  admittedSelections?: Record<string, ModelSelectionRecord>,
): ChatMessage {
  return {
    id: `${turnId}:user`,
    role: "user",
    text: `Question for ${turnId}`,
    turnId,
    createdAt: "2026-09-05T10:00:00.000Z",
    ...(admittedSelections
      ? {
          turnRequest: {
            fingerprint: turnId,
            expectedReplies: Object.keys(admittedSelections).length,
            admittedSelections,
          },
        }
      : {}),
  };
}

it("places a default-use notice directly under the question that admitted it", () => {
  const messages = [
    userMessage("turn-1", { Reviewer: agentDefault() }),
    userMessage("turn-2"),
  ];

  expect(
    buildConversationTimeline(messages, [], []).map((item) =>
      item.kind === "model-selection"
        ? `selection:${item.userMessage.turnId}`
        : item.kind === "message"
          ? `message:${item.message.turnId}`
          : item.kind,
    ),
  ).toEqual(["message:turn-1", "selection:turn-1", "message:turn-2"]);
});

it("summarizes every default-mode speaker of one turn in a single notice", () => {
  const [, notice] = buildConversationTimeline(
    [
      userMessage("turn-1", {
        Reviewer: agentDefault(),
        Researcher: agentDefault("codex", "gpt-5.6-sol"),
      }),
    ],
    [],
    [],
  );

  expect(notice?.kind).toBe("model-selection");
  if (notice?.kind !== "model-selection") return;
  expect(notice.selections.map((entry) => entry.speaker)).toEqual([
    "Researcher",
    "Reviewer",
  ]);
});

it("does not label an explicit agent that happens to equal the default", () => {
  // Same pair, different decision. A notice here would tell the user their
  // agent inherited a setting it actually declares for itself.
  const timeline = buildConversationTimeline(
    [userMessage("turn-1", { Reviewer: explicitAgent() })],
    [],
    [],
  );

  expect(timeline.every((item) => item.kind !== "model-selection")).toBe(true);
});

it("emits nothing for a turn recorded before provenance existed", () => {
  const timeline = buildConversationTimeline([userMessage("turn-1")], [], []);

  expect(timeline.every((item) => item.kind !== "model-selection")).toBe(true);
});

it("offers the app default under the question whose attempt failed", () => {
  const offer = {
    offerId: "offer-1",
    scope: { kind: "chat" as const, sessionId: "session-1", turnId: "turn-1" },
    agentName: "Reviewer",
    expectedRevision: "revision-1",
    failedChoice: { provider: "anthropic", model: "claude-sonnet-4-6" },
    proposedDefault: { provider: "openai", model: "gpt-5" },
    reason: "missing-credential" as const,
  };

  expect(
    buildConversationTimeline(
      [userMessage("turn-1"), userMessage("turn-2")],
      [],
      [],
      [offer],
    ).map((item) =>
      item.kind === "model-choice"
        ? `choice:${item.offer.scope.kind === "chat" ? item.offer.scope.turnId : ""}`
        : item.kind === "message"
          ? `message:${item.message.turnId}`
          : item.kind,
    ),
  ).toEqual(["message:turn-1", "choice:turn-1", "message:turn-2"]);
});

it("offers nothing when the server offered nothing", () => {
  expect(
    buildConversationTimeline([userMessage("turn-1")], [], [], []).every(
      (item) => item.kind !== "model-choice",
    ),
  ).toBe(true);
});

it("says which model named the session, in the same notice as the turn that named it", () => {
  // Titling runs on the application default and owns no Agent, so without this
  // a session could be named by a model nothing on the page ever mentions. It
  // belongs to the turn that caused it, so it joins that turn's notice rather
  // than opening a second surface.
  const titleAttempt = {
    operation: "selected-agent-chat" as const,
    owner: "turn-1",
    attemptId: "attempt-1",
    selection: {
      provider: "openai",
      model: "app-default-model",
      source: "app-default" as const,
      reason: "agent-default" as const,
      caller: "title" as const,
    },
    at: "2026-09-09T12:00:00.000Z",
  };

  const timeline = buildConversationTimeline(
    [userMessage("turn-1", { Reviewer: explicitAgent() }), userMessage("turn-2")],
    [],
    [],
    [],
    [titleAttempt],
  );

  const notice = timeline.find((item) => item.kind === "model-selection");
  expect(notice?.kind).toBe("model-selection");
  if (notice?.kind !== "model-selection") return;
  // The Agent chose its own pair, so only the title is disclosed here.
  expect(notice.userMessage.turnId).toBe("turn-1");
  expect(notice.selections).toEqual([
    { speaker: "session title", selection: titleAttempt.selection, attemptId: "attempt-1" },
  ]);
});

it("attaches a title attempt to its own turn and no other", () => {
  const timeline = buildConversationTimeline(
    [userMessage("turn-1"), userMessage("turn-2")],
    [],
    [],
    [],
    [
      {
        operation: "session-chat" as const,
        owner: "turn-2",
        attemptId: "attempt-2",
        selection: {
          provider: "openai",
          model: "ad-hoc-user-model",
          source: "user" as const,
          reason: "explicit-user-choice" as const,
          caller: "title" as const,
        },
        at: "2026-09-09T12:00:00.000Z",
      },
    ],
  );

  expect(
    timeline.map((item) =>
      item.kind === "model-selection"
        ? `selection:${item.userMessage.turnId}`
        : item.kind === "message"
          ? `message:${item.message.turnId}`
          : item.kind,
    ),
  ).toEqual(["message:turn-1", "message:turn-2", "selection:turn-2"])
})

it("ignores a title attempt that belongs to something other than a chat turn", () => {
  // A Team launch owns an admitted task and a schedule owns a fire; neither has
  // a chat turn. Their owner ids are not turn ids, so matching them against one
  // would attach a notice to whichever turn happened to share a string — or,
  // worse, look correct until an id collided. Those callers get their own
  // placement when their slices are built.
  const timeline = buildConversationTimeline(
    [userMessage("turn-1")],
    [],
    [],
    [],
    [
      {
        operation: "team-launch" as const,
        owner: "turn-1",
        attemptId: "attempt-launch",
        selection: {
          provider: "openai",
          model: "app-default-model",
          source: "app-default" as const,
          reason: "agent-default" as const,
          caller: "title" as const,
        },
        at: "2026-09-09T12:00:00.000Z",
      },
      {
        operation: "scheduled-filename" as const,
        owner: "turn-1",
        attemptId: "attempt-fire",
        selection: {
          provider: "openai",
          model: "app-default-model",
          source: "app-default" as const,
          reason: "agent-default" as const,
          caller: "title" as const,
        },
        at: "2026-09-09T12:00:00.000Z",
      },
    ],
  );

  expect(timeline.some((item) => item.kind === "model-selection")).toBe(false)
})

it("finds a title attempt owned by the message itself when the turn has no id", () => {
  // Generic chat does not always mint a turn id, so the attempt is owned by the
  // persisted user message instead. Looking only at `turnId` would leave those
  // sessions with a record on disk and nothing on the page.
  const message: ChatMessage = {
    id: "user-message-1",
    role: "user",
    text: "Summarise the supply agreement.",
    createdAt: "2026-09-09T10:00:00.000Z",
  };

  const timeline = buildConversationTimeline(
    [message],
    [],
    [],
    [],
    [
      {
        operation: "session-chat" as const,
        owner: "user-message-1",
        attemptId: "attempt-1",
        selection: {
          provider: "openai",
          model: "app-default-model",
          source: "app-default" as const,
          reason: "agent-default" as const,
          caller: "title" as const,
        },
        at: "2026-09-09T10:00:01.000Z",
      },
    ],
  );

  const notice = timeline.find((item) => item.kind === "model-selection");
  expect(notice?.kind).toBe("model-selection");
  if (notice?.kind !== "model-selection") return;
  expect(notice.userMessage.id).toBe("user-message-1");
  expect(notice.selections).toEqual([
    {
      speaker: "session title",
      selection: {
        provider: "openai",
        model: "app-default-model",
        source: "app-default",
        reason: "agent-default",
        caller: "title",
      },
      attemptId: "attempt-1",
    },
  ]);
})

it("does not let a message id collide with an unrelated owner", () => {
  // A task or a fire owner is not a chat owner. Falling back to the message id
  // must not widen what a chat notice will claim.
  const message: ChatMessage = {
    id: "user-message-1",
    role: "user",
    text: "Summarise the supply agreement.",
    createdAt: "2026-09-09T10:00:00.000Z",
  };

  const timeline = buildConversationTimeline(
    [message],
    [],
    [],
    [],
    [
      {
        operation: "scheduled-filename" as const,
        owner: "user-message-1",
        attemptId: "attempt-fire",
        selection: {
          provider: "openai",
          model: "app-default-model",
          source: "app-default" as const,
          reason: "agent-default" as const,
          caller: "title" as const,
        },
        at: "2026-09-09T10:00:01.000Z",
      },
    ],
  );

  expect(timeline.some((item) => item.kind === "model-selection")).toBe(false)
})

// ── A Team launch: owned by a task, never by a turn ─────────────────────────

const TEAM_LAUNCH_SELECTION: ModelSelectionRecord = {
  provider: "openai",
  model: "app-default-model",
  source: "app-default",
  reason: "agent-default",
  caller: "title",
};

function teamLaunchAttempt(owner: string, attemptId = "attempt-team") {
  return {
    operation: "team-launch" as const,
    owner,
    attemptId,
    selection: TEAM_LAUNCH_SELECTION,
    at: "2026-09-09T10:00:05.000Z",
  };
}

function teamTask(id: string, turnId?: string) {
  return {
    id,
    ...(turnId === undefined ? {} : { sourceTurn: { turnId, fingerprint: `fp-${id}` } }),
  };
}

it("puts a Team launch notice under the brief that caused it", () => {
  // The attempt is owned by the admitted task. The task records the turn it
  // came from, and that turn is the brief in the transcript — three real
  // records, joined, rather than one string matched against another kind.
  const timeline = buildConversationTimeline(
    [userMessage("turn-a")],
    [],
    [],
    [],
    [teamLaunchAttempt("task-a")],
    [teamTask("task-a", "turn-a")],
  );

  const notice = timeline.find((item) => item.kind === "model-selection");
  expect(notice?.kind).toBe("model-selection");
  if (notice?.kind !== "model-selection") return;
  expect(notice.userMessage.turnId).toBe("turn-a");
  expect(notice.selections).toEqual([
    {
      speaker: "session title",
      selection: TEAM_LAUNCH_SELECTION,
      attemptId: "attempt-team",
    },
  ]);
});

it("does not let a later Team task take over an earlier launch's notice", () => {
  // Task B names nothing, because the session already has a name. Reading only
  // the latest task would erase A's account of the model that really did name
  // it, which is the history this record exists to keep.
  const timeline = buildConversationTimeline(
    [userMessage("turn-a"), userMessage("turn-b")],
    [],
    [],
    [],
    [teamLaunchAttempt("task-a")],
    [teamTask("task-a", "turn-a"), teamTask("task-b", "turn-b")],
  );

  const notices = timeline.filter((item) => item.kind === "model-selection");
  expect(notices).toHaveLength(1);
  const [notice] = notices;
  if (notice?.kind !== "model-selection") return;
  expect(notice.userMessage.turnId).toBe("turn-a");
});

it("never matches a task owner against a turn of the same name", () => {
  // The owner of a Team launch is a task id. A turn that happens to be called
  // the same thing is a different kind of identity, and hanging the notice on
  // it would be a coincidence presented as a fact.
  const timeline = buildConversationTimeline(
    [userMessage("task-a")],
    [],
    [],
    [],
    [teamLaunchAttempt("task-a")],
    // No task by that name exists.
    [],
  );

  expect(
    timeline.some(
      (item) => item.kind === "model-selection" && item.userMessage.turnId === "task-a",
    ),
  ).toBe(false);
});

it("still shows a Team launch notice whose task has no brief to hang it on", () => {
  // A launch made through the API entry persists a brief without a turn, so
  // there is no message to anchor to. The record is still an account of a model
  // that really was used, and a session opened later has to be able to show it —
  // dropping it would lose the disclosure, and inventing an anchor would put it
  // somewhere it does not belong.
  const timeline = buildConversationTimeline(
    [userMessage("turn-a")],
    [],
    [],
    [],
    [teamLaunchAttempt("task-untethered")],
    [teamTask("task-untethered")],
  );

  const notice = timeline.find((item) => item.kind === "session-model-selection");
  expect(notice?.kind).toBe("session-model-selection");
  if (notice?.kind !== "session-model-selection") return;
  expect(notice.selections).toEqual([
    {
      speaker: "session title",
      selection: TEAM_LAUNCH_SELECTION,
      attemptId: "attempt-team",
    },
  ]);
  // And it is not also claimed by the turn that happens to be in the transcript.
  expect(timeline.some((item) => item.kind === "model-selection")).toBe(false);
});

it("does not lose a Team launch notice when its brief is not loaded", () => {
  // The task resolves to a turn, but that turn's message is not in this view —
  // a transcript still loading, or a window that does not reach back that far.
  // Resolving to a turn nobody can see is not the same as having no record, and
  // dropping it would hide a model that really was used.
  const timeline = buildConversationTimeline(
    [],
    [],
    [],
    [],
    [teamLaunchAttempt("task-a")],
    [teamTask("task-a", "turn-a")],
  );

  const notice = timeline.find((item) => item.kind === "session-model-selection");
  expect(notice?.kind).toBe("session-model-selection");
});

it("never attaches a Team launch to a message that merely shares its turn id", () => {
  // A message written before turn ids existed carries none, and is looked up by
  // its own id. A Team launch resolves to a *turn*, so it may only meet a
  // message that really is on that turn — otherwise one older line whose id
  // happens to read like a turn would be labelled with a naming it had nothing
  // to do with.
  const legacyMessage: ChatMessage = {
    id: "turn-a",
    role: "user",
    text: "A line from before turns had identities.",
    createdAt: "2026-09-09T09:00:00.000Z",
  };

  const timeline = buildConversationTimeline(
    [legacyMessage],
    [],
    [],
    [],
    [teamLaunchAttempt("task-a")],
    [teamTask("task-a", "turn-a")],
  );

  expect(timeline.some((item) => item.kind === "model-selection")).toBe(false);
  expect(timeline.some((item) => item.kind === "session-model-selection")).toBe(true);
});

it("shows what named a scheduled run's artifact, against the session", () => {
  // A schedule fires with nobody watching, and names its result file before it
  // admits anything — so there is no turn and no task for the notice to sit
  // under. The session is what the fire has, and what the person opens later.
  const timeline = buildConversationTimeline(
    [],
    [],
    [],
    [],
    [
      {
        operation: "scheduled-filename" as const,
        owner: "session-of-the-fire",
        attemptId: "attempt-fire",
        selection: TEAM_LAUNCH_SELECTION,
        at: "2026-09-09T10:00:05.000Z",
      },
    ],
  );

  const notice = timeline.find((item) => item.kind === "session-model-selection");
  expect(notice?.kind).toBe("session-model-selection");
  if (notice?.kind !== "session-model-selection") return;
  expect(notice.selections).toEqual([
    {
      // What it named was a file, not the session. Saying "session title" here
      // would describe work that did not happen.
      speaker: "artifact filename",
      selection: TEAM_LAUNCH_SELECTION,
      attemptId: "attempt-fire",
    },
  ]);
});

it("still calls a Team launch's naming what it is", () => {
  // The guard on the case above: naming the session and naming a file are
  // different pieces of work, and one label must not be applied to both.
  const timeline = buildConversationTimeline(
    [],
    [],
    [],
    [],
    [teamLaunchAttempt("task-untethered")],
    [teamTask("task-untethered")],
  );

  // Asserted on the value found, not behind a narrowing guard: a guard that
  // returns when the notice is missing would pass for a notice that vanished.
  expect(
    timeline.find((item) => item.kind === "session-model-selection"),
  ).toMatchObject({
    kind: "session-model-selection",
    selections: [{ speaker: "session title" }],
  });
});

it("shows which model named a delegated job, against the conversation", () => {
  // A routing stage asks a model for a short title for the work it hands over.
  // That helper owns no Agent and no chat turn — it runs in the team runtime —
  // so its account arrives from the delegation's own journal rather than from
  // the session's, and it belongs to the conversation the Team is running in.
  const timeline = buildConversationTimeline(
    [],
    [],
    [],
    [],
    [],
    [],
    [
      {
        key: "parent-session:research-team:abc",
        speaker: "job title",
        selection: TEAM_LAUNCH_SELECTION,
        at: "2026-09-09T10:00:07.000Z",
      },
    ],
  );

  const notice = timeline.find((item) => item.kind === "session-model-selection");
  expect(notice?.kind).toBe("session-model-selection");
  if (notice?.kind !== "session-model-selection") return;
  expect(notice.selections).toEqual([
    {
      // Named for what it is. It is not an Agent, not the host, and not the
      // session's own title.
      speaker: "job title",
      selection: TEAM_LAUNCH_SELECTION,
      attemptId: "parent-session:research-team:abc",
    },
  ]);
});

it("shows one notice per delegation, however often its job was named", () => {
  // The same delegation reported twice is one naming, not two. Its identity is
  // what says so.
  const naming = {
    key: "parent-session:research-team:abc",
    speaker: "job title",
    selection: TEAM_LAUNCH_SELECTION,
    at: "2026-09-09T10:00:07.000Z",
  };

  const timeline = buildConversationTimeline([], [], [], [], [], [], [naming, naming]);

  expect(
    timeline.filter((item) => item.kind === "session-model-selection"),
  ).toHaveLength(1);
});

it("names each background helper rather than reporting them all alike", () => {
  // Compressing a discussion and writing its minutes are different work. A
  // notice that only said the application default was used would leave a person
  // unable to tell what that model actually did.
  const timeline = buildConversationTimeline(
    [],
    [],
    [],
    [],
    [],
    [],
    [
      {
        key: "helper-1",
        speaker: "context compression",
        selection: TEAM_LAUNCH_SELECTION,
        at: "2026-09-09T10:00:07.000Z",
      },
      {
        key: "helper-2",
        speaker: "meeting minutes",
        selection: TEAM_LAUNCH_SELECTION,
        at: "2026-09-09T10:00:08.000Z",
      },
    ],
  );

  expect(
    timeline
      .filter((item) => item.kind === "session-model-selection")
      .flatMap((item) =>
        item.kind === "session-model-selection"
          ? item.selections.map((one) => one.speaker)
          : [],
      ),
  ).toEqual(["context compression", "meeting minutes"]);
});

it("shows one Team launch notice when a legacy line shares its turn's name", () => {
  // The positive control and the collision in one transcript: the real brief is
  // on turn-a, and an older line is *called* turn-a. Knowing that some message
  // is on that turn is not enough — the destination message itself has to be,
  // or one attempt is disclosed twice and one of the two is a coincidence.
  const brief = userMessage("turn-a");
  const legacyMessage: ChatMessage = {
    id: "turn-a",
    role: "user",
    text: "A line from before turns had identities.",
    createdAt: "2026-09-09T09:00:00.000Z",
  };

  const timeline = buildConversationTimeline(
    [brief, legacyMessage],
    [],
    [],
    [],
    [teamLaunchAttempt("task-a")],
    [teamTask("task-a", "turn-a")],
  );

  const notices = timeline.filter((item) => item.kind === "model-selection");
  expect(notices).toHaveLength(1);
  const [notice] = notices;
  if (notice?.kind !== "model-selection") return;
  expect(notice.userMessage.id).toBe(brief.id);
  expect(timeline.some((item) => item.kind === "session-model-selection")).toBe(false);
});
