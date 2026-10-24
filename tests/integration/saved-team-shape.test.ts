/**
 * Changing how a team that already exists works together.
 *
 * Until now the only moment a shape could be chosen was before the build. That
 * left the user one chance: a team that turned out to need a discussion rather
 * than a chain had to be thrown away and described again from scratch.
 *
 * A saved team is not a plan. Its file is the product — hand-edited comments,
 * per-member model pins, artifacts nobody else knows about — so the change is
 * surgical, guarded by the revision the editor was showing, and refused when
 * the file is not one this feature knows how to rewrite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import {
  teamShapeSchema,
  type TeamShape,
} from "../../contracts/schemas/team-shape.js";
import { handleTeamBuilderRoutes } from "../../server/routes/team-builder.js";
import {
  addTeamBuilderAgents,
  changeSavedTeamShape,
  TeamRevisionConflictError,
} from "../../domains/agent-generator/team-manager.js";

const TEAM_ID = "contract-review";

const discussion: TeamShape = {
  kind: "discussion",
  rationale: "They disagree usefully.",
  depth: "standard",
  coordinator: "risk-lead",
  participants: ["risk-spotter"],
};

/** Ways an author may have made the file their own without breaking it. */
interface AuthorEdits {
  stageHeader?: string;
  configHeader?: string;
  sequenceNote?: string;
  extraConfig?: string[];
  handoffLine?: string;
  /** One roster member the product deliberately keeps out of the UI. */
  hiddenAgent?: string;
  blankBeforeSequenceNote?: boolean;
  /**
   * Lines the author wrote inside the stage, above `sequence:`.
   *
   * Comments in YAML carry no indentation contract, and people outdent them to
   * the margin to make them stand out. A note written that way is still inside
   * the stage it was written in.
   */
  stageNotes?: string[];
  /** The same, inside `config:`, below the handoff setting. */
  configNotes?: string[];
  /** Lines the author wrote between the stage and the gates that follow it. */
  noteBeforeGates?: string[];
}

/** A generated, published team: a chain of two, with bytes nobody else owns. */
function writeGeneratedTeam(
  repoRoot: string,
  extra: string[] = [],
  edits: AuthorEdits = {},
): void {
  const teamDir = path.join(repoRoot, "teams", TEAM_ID);
  fs.mkdirSync(teamDir, { recursive: true });
  for (const name of ["risk-lead", "risk-spotter"]) {
    const agentDir = path.join(repoRoot, "agents", name);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, `${name}.md`),
      [
        "---",
        `name: ${name}`,
        `description: ${name}.`,
        "tier: strategic",
        ...(edits.hiddenAgent === name ? ["ui_hidden: true"] : []),
        "---",
        "",
        `# ${name}`,
        "",
      ].join("\n"),
    );
  }
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    [
      "team:",
      `  name: "${TEAM_ID}"`,
      "  description: Reviews contracts.",
      '  version: "0.1.0"',
      '  created_by: "team-builder"',
      '  created_by_orchestrator: "plan-1"',
      '  published_by: "plan-1@sha256:one"',
      "",
      "workspace:",
      "  path: ../../workspace",
      "  watch: false",
      "",
      "workflow:",
      "  entry_level: setup",
      "  invocation_modes:",
      "    - user",
      "  user_facing: true",
      "  output_contract:",
      "    artifacts:",
      '      - path: "final-result.md"',
      "        required: true",
      "        description: Final result produced by the generated team.",
      '    completion_artifact: "final-result.md"',
      "",
      "agents:",
      '  - name: "risk-lead"',
      "    type: agent",
      "    role: Lead.",
      "    tools: []",
      '    agent_file: "../../agents/risk-lead/risk-lead.md"',
      // A per-member pin nothing in this feature knows about.
      "    model: pinned/lead-model",
      '  - name: "risk-spotter"',
      "    type: agent",
      "    role: Spotter.",
      "    tools: []",
      '    agent_file: "../../agents/risk-spotter/risk-spotter.md"',
      "    produces:",
      '      - path: "final-result.md"',
      "",
      "levels:",
      "  - id: setup",
      "    name: Setup",
      "    order: 0",
      "    # The level this team runs. Written by hand after the build.",
      edits.stageHeader ?? "    stage:",
      "      type: chain",
      ...(edits.stageNotes ?? []),
      "      sequence:",
      '        - "risk-lead"',
      ...(edits.blankBeforeSequenceNote ? [""] : []),
      ...(edits.sequenceNote ? [edits.sequenceNote] : []),
      '        - "risk-spotter"',
      "      # How it behaves, adjusted since it was generated.",
      edits.configHeader ?? "      config:",
      edits.handoffLine ?? "        handoff_format: markdown",
      ...(edits.configNotes ?? []),
      ...(edits.extraConfig ?? []),
      "        constraints:",
      "          - Quote the clause before judging it.",
      "        output:",
      '          format: "final-result.md"',
      // Turned on by hand. A wholesale rewrite would quietly turn it off.
      "          user_review: true",
      ...(edits.noteBeforeGates ?? [""]),
      "gates:",
      "  - from: setup",
      "    to: done",
      "    condition:",
      "      type: artifact_exists",
      '      artifact: "final-result.md"',
      ...extra,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    [
      `${TEAM_ID}:`,
      "  type: team",
      "  description: Reviews contracts.",
      `  team_path: ./teams/${TEAM_ID}`,
      "",
    ].join("\n"),
  );
}

interface Harness {
  origin: string;
  repoRoot: string;
  close: () => Promise<void>;
}

async function serve(repoRoot: string): Promise<Harness> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleTeamBuilderRoutes({
      req,
      res,
      url,
      options: { repoRootPath: repoRoot },
    }).then(
      (handled) => {
        if (!handled && !res.writableEnded) res.writeHead(404).end();
      },
      (error: unknown) => {
        if (!res.writableEnded) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    repoRoot,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function withTeam(
  fn: (harness: Harness) => Promise<void>,
  extra: string[] = [],
  edits: AuthorEdits = {},
): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saved-team-shape-"));
  writeGeneratedTeam(repoRoot, extra, edits);
  const harness = await serve(repoRoot);
  try {
    await fn(harness);
  } finally {
    await harness.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function readTeam(
  harness: Harness,
): Promise<{ shape?: TeamShape; revision?: string; agents?: { name: string }[] }> {
  const response = await fetch(
    `${harness.origin}/create/team-builder/teams/${TEAM_ID}`,
  );
  const body = (await response.json()) as { team: Record<string, unknown> };
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.team as never;
}

async function changeShape(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${harness.origin}/create/team-builder/teams/${TEAM_ID}/shape`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const parsed: unknown = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body: parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {},
  };
}

function teamYaml(harness: Harness): string {
  return fs.readFileSync(
    path.join(harness.repoRoot, "teams", TEAM_ID, "team.yaml"),
    "utf8",
  );
}

test("a saved generated team reports how it works together, and what to write against", async () => {
  await withTeam(async (harness) => {
    const team = await readTeam(harness);
    // Checked against the contract every other reader uses, not against a
    // shape of this test's own imagining: a value that only looks right would
    // be refused the moment the real client read it.
    const parsed = teamShapeSchema.safeParse(team.shape);
    assert.ok(parsed.success, JSON.stringify(parsed, null, 2));
    assert.equal(parsed.data.kind, "chain");
    assert.deepEqual(
      parsed.data.kind === "chain" ? parsed.data.order : [],
      ["risk-lead", "risk-spotter"],
    );
    assert.ok(team.revision, "the editor has nothing to write against");
  });
});

test("changing a saved team's shape rewrites its stage and nothing else", async () => {
  await withTeam(async (harness) => {
    const before = teamYaml(harness);
    const team = await readTeam(harness);
    const answer = await changeShape(harness, {
      shape: discussion,
      expectedRevision: team.revision,
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));

    const after = teamYaml(harness);
    assert.match(after, /^ {6}type: discussion$/mu);
    assert.match(after, /^ {6}coordinator: "risk-lead"$/mu);
    assert.match(after, /^ {8}max_rounds: 3$/mu);
    assert.doesNotMatch(after, /type: chain/u);
    assert.doesNotMatch(after, /handoff_format/u);

    // Byte-for-byte, not line-by-line, so a change that reordered or duplicated
    // anything would be caught. The one thing that may move in the roster is
    // who declares the result: that is part of the arrangement, so it is taken
    // out of both sides and asserted separately below.
    // Both spellings of "declares the result": the block, and the empty list
    // the writer leaves where a block was removed.
    const withoutOwnership = (yaml: string) =>
      yaml
        .replace(/\n {4}produces:\n {6}- path: "final-result\.md"/gu, "")
        .replace(/\n {4}produces: \[\]/gu, "");
    const upTo = (yaml: string) =>
      withoutOwnership(yaml.slice(0, yaml.indexOf("    stage:")));
    const from = (yaml: string) => yaml.slice(yaml.indexOf("\ngates:"));
    assert.equal(upTo(after), upTo(before));
    assert.equal(from(after), from(before));

    // And inside the stage, what the feature does not own is still there: a
    // comment, a constraint nobody else declared, and a review setting somebody
    // turned on by hand.
    assert.match(after, /^ {6}# How it behaves, adjusted since it was generated\.$/mu);
    assert.match(after, /^ {8}constraints:$/mu);
    assert.match(after, /^ {10}- Quote the clause before judging it\.$/mu);
    assert.match(after, /^ {10}user_review: true$/mu);
    assert.match(after, /^ {10}format: "final-result\.md"$/mu);
  });
});

test("a change written against a revision that has moved is refused", async () => {
  await withTeam(async (harness) => {
    const team = await readTeam(harness);
    const first = await changeShape(harness, {
      shape: discussion,
      expectedRevision: team.revision,
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const stale = await changeShape(harness, {
      shape: {
        kind: "review",
        rationale: "One writes, one checks.",
        depth: "quick",
        producer: "risk-lead",
        reviewer: "risk-spotter",
      },
      expectedRevision: team.revision,
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.match(teamYaml(harness), /type: discussion/u);
    // The team as it now stands, so the editor can redraw from what is there
    // rather than telling the user to reopen it themselves.
    const current = stale.body.team as Record<string, unknown> | undefined;
    assert.ok(current, JSON.stringify(stale.body));
    assert.equal((current.shape as { kind?: string } | undefined)?.kind, "discussion");
    assert.notEqual(current.revision, team.revision);
  });
});

test("a shape that does not account for every member is refused", async () => {
  await withTeam(async (harness) => {
    const team = await readTeam(harness);
    const answer = await changeShape(harness, {
      shape: {
        kind: "discussion",
        rationale: "Leaving someone out.",
        depth: "quick",
        coordinator: "risk-lead",
        participants: [],
      },
      expectedRevision: team.revision,
    });
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.match(teamYaml(harness), /type: chain/u);
  });
});

test("a team this feature did not write is not rewritten", async () => {
  await withTeam(async (harness) => {
    // Neither marker. A file with one of them is a team this app built before
    // the newer marker existed, and that one is still its own.
    const teamYamlPath = path.join(harness.repoRoot, "teams", TEAM_ID, "team.yaml");
    fs.writeFileSync(
      teamYamlPath,
      fs
        .readFileSync(teamYamlPath, "utf8")
        .replace(/^\s*created_by: .*\n/mu, "")
        .replace(/^\s*created_by_orchestrator: .*\n/mu, ""),
    );
    const team = await readTeam(harness);
    assert.equal(team.shape, undefined);
    const answer = await changeShape(harness, {
      shape: discussion,
      expectedRevision: team.revision,
    });
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.match(teamYaml(harness), /type: chain/u);
  });
});

// A team built before the newer provenance marker existed is still one this
// app wrote, and its shape is still its own to change.
test("a team from before the newer provenance marker can still be changed", async () => {
  await withTeam(async (harness) => {
    const teamYamlPath = path.join(harness.repoRoot, "teams", TEAM_ID, "team.yaml");
    fs.writeFileSync(
      teamYamlPath,
      fs.readFileSync(teamYamlPath, "utf8").replace(/^\s*created_by: .*\n/mu, ""),
    );
    const team = await readTeam(harness);
    assert.equal(team.shape?.kind, "chain");
    const answer = await changeShape(harness, {
      shape: discussion,
      expectedRevision: team.revision,
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.match(teamYaml(harness), /type: discussion/u);
  });
});

// What makes a saved team's shape this app's to change is not only that it
// wrote the file once. The stage has to still be the arrangement it emits: the
// first level, producing the artifact the completion gate waits for, with that
// one gate and no other. A file that has moved away from any of those is a team
// somebody has made their own, and rewriting its stage would break whatever
// they built around it.
test("a team whose arrangement has been changed by hand is left alone", async () => {
  for (
    const [name, edit] of [
      ["the level is no longer first", (yaml: string) =>
        yaml.replace(/^ {4}order: 0$/mu, "    order: 1")],
      ["the stage produces a different artifact", (yaml: string) =>
        yaml.replace(/^ {10}format: "final-result\.md"$/mu, '          format: "other.md"')],
      ["the gate waits for a different artifact", (yaml: string) =>
        yaml.replace(/^ {6}artifact: "final-result\.md"$/mu, '      artifact: "other.md"')],
      ["another gate was added", (yaml: string) =>
        `${yaml.trimEnd()}\n  - from: setup\n    to: review\n    condition:\n      type: artifact_exists\n      artifact: "draft.md"\n`],
    ] as const
  ) {
    await withTeam(async (harness) => {
      const teamYamlPath = path.join(harness.repoRoot, "teams", TEAM_ID, "team.yaml");
      const edited = edit(fs.readFileSync(teamYamlPath, "utf8"));
      fs.writeFileSync(teamYamlPath, edited);

      // Nothing to read, so the editor offers nothing to change.
      const team = await readTeam(harness);
      assert.equal(team.shape, undefined, `${name}: a shape was still offered`);

      const answer = await changeShape(harness, {
        shape: discussion,
        expectedRevision: team.revision,
      });
      assert.equal(answer.status, 422, `${name}: ${JSON.stringify(answer.body)}`);
      assert.equal(
        fs.readFileSync(teamYamlPath, "utf8"),
        edited,
        `${name}: the file was rewritten anyway`,
      );
    });
  }
});

// A team still being built has a half-assembled roster. Its shape is the
// build's to decide, and the editor must not advertise otherwise.
test("a team that is still being built offers no shape to change", async () => {
  await withTeam(async (harness) => {
    const teamYamlPath = path.join(harness.repoRoot, "teams", TEAM_ID, "team.yaml");
    fs.writeFileSync(
      teamYamlPath,
      fs
        .readFileSync(teamYamlPath, "utf8")
        .replace(/^ {2}description: Reviews contracts\.$/mu, "  description: Reviews contracts.\n  building: true"),
    );

    const team = await readTeam(harness);
    assert.equal(team.shape, undefined);
    const answer = await changeShape(harness, {
      shape: discussion,
      expectedRevision: team.revision,
    });
    assert.notEqual(answer.status, 200, JSON.stringify(answer.body));
  });
});

// The artifact the run publishes has an owner, and which member owns it is part
// of the arrangement. A chain's last member writes it; a discussion's lead
// writes it; a review's is written by the runtime once the reviewer approves.
test("changing the shape moves who produces the result, and nothing else about the roster", async () => {
  await withTeam(async (harness) => {
    const before = teamYaml(harness);
    // The chain's last member owns it to begin with.
    assert.match(before, /^ {2}- name: "risk-spotter"$/mu);
    const spotterOwns = /- name: "risk-spotter"[\s\S]*?produces:\n {6}- path: "final-result\.md"/u;
    assert.match(before, spotterOwns);

    const team = await readTeam(harness);
    const answer = await changeShape(harness, {
      shape: discussion,
      expectedRevision: team.revision,
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));

    const after = teamYaml(harness);
    // The discussion's lead now owns it, and the previous owner does not.
    assert.match(
      after,
      /- name: "risk-lead"[\s\S]*?produces:\n {6}- path: "final-result\.md"/u,
    );
    assert.doesNotMatch(after, spotterOwns);
    // And nothing else about that member moved.
    assert.match(after, /^ {4}model: pinned\/lead-model$/mu);
    assert.match(after, /^ {4}role: Spotter\.$/mu);
  });
});

// A header can carry a comment, and a setting can have a note written under it.
// Matching only bare headers found nothing and silently changed nothing, or
// wrote a second block beside the one already there and split the settings
// between them.
test("a stage whose headers carry comments is changed once, in place", async () => {
  await withTeam(
    async (harness) => {
      const before = teamYaml(harness);
      assert.match(before, /^ {4}stage: {2}# Keep this stage note$/mu);
      const team = await readTeam(harness);
      assert.equal(team.shape?.kind, "chain");

      const answer = await changeShape(harness, {
        shape: discussion,
        expectedRevision: team.revision,
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));

      const after = teamYaml(harness);
      assert.match(after, /^ {6}type: discussion$/mu);
      // One stage, one config. A second header would split the settings.
      assert.equal(after.match(/^ {4}stage:/gmu)?.length, 1);
      assert.equal(after.match(/^ {6}config:/gmu)?.length, 1);
      // The notes on both headers are still theirs.
      assert.match(after, /^ {4}stage: {2}# Keep this stage note$/mu);
      assert.match(after, /^ {6}config: {2}# Keep these settings$/mu);
      // And the settings this change does not own are still under that one
      // config, not orphaned beside it.
      const config = after.slice(after.indexOf("      config:"));
      assert.match(config, /^ {8}constraints:$/mu);
      assert.match(config, /^ {10}user_review: true$/mu);
      // A note written under a setting that was replaced is still the author's.
      assert.match(after, /# The order was argued about\./u);
    },
    [],
    {
      stageHeader: "    stage:  # Keep this stage note",
      configHeader: "      config:  # Keep these settings",
      sequenceNote: "        # The order was argued about.",
    },
  );
});

// A setting that belongs to one arrangement and not another must not survive
// the change: a discussion has no handoff format, and a chain has no reviewer
// rule.
test("settings that belong to the old arrangement do not survive it", async () => {
  await withTeam(
    async (harness) => {
      const team = await readTeam(harness);
      const answer = await changeShape(harness, {
        shape: discussion,
        expectedRevision: team.revision,
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));

      const after = teamYaml(harness);
      for (const stale of ["mode:", "min_successful_participants:", "on_reviewer_skip:"]) {
        assert.ok(
          !after.includes(stale),
          `the change left ${stale} behind from the old arrangement`,
        );
      }
    },
    [],
    {
      extraConfig: [
        "        mode: strict",
        "        min_successful_participants: 2",
        "        on_reviewer_skip: continue",
      ],
    },
  );
});

// A team can be created before it has anybody in it, and then filled. Its
// stage names nobody, which is not an arrangement anything can describe — so
// there is nothing to report and nothing to change, and the team itself has to
// stay perfectly readable so members can be added to it.
test("a team with nobody in it yet is readable, and offers no shape", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saved-team-empty-"));
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  const harness = await serve(repoRoot);
  try {
    const created = await fetch(`${harness.origin}/create/team-builder/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "empty-team",
        description: "A team to fill.",
        tags: [],
      }),
    });
    const createdBody = (await created.json()) as { team: Record<string, unknown> };
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    assert.equal(createdBody.team.shape, undefined, JSON.stringify(createdBody.team));

    const read = await fetch(
      `${harness.origin}/create/team-builder/teams/empty-team`,
    );
    const readBody = (await read.json()) as { team: Record<string, unknown> };
    assert.equal(read.status, 200, JSON.stringify(readBody));
    assert.equal(readBody.team.shape, undefined, JSON.stringify(readBody.team));
    assert.ok(readBody.team.revision, "an empty team still has a revision");
  } finally {
    await harness.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Depth is not a number the editor invents. The three it can describe are the
// three it emits; a saved team set to anything else is doing something this
// app cannot state, and rounding it down would put a sentence on screen —
// "one pass each" — that the team does not obey.
test("a saved team set to a round count this app cannot describe offers no shape", async () => {
  for (const [rounds, described] of [[1, true], [2, false], [3, true], [5, true], [7, false]] as const) {
    await withTeam(async (harness) => {
      const team = await readTeam(harness);
      const changed = await changeShape(harness, {
        shape: discussion,
        expectedRevision: team.revision,
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));

      // Set by hand to a count this app never writes.
      const teamYamlPath = path.join(harness.repoRoot, "teams", TEAM_ID, "team.yaml");
      fs.writeFileSync(
        teamYamlPath,
        fs
          .readFileSync(teamYamlPath, "utf8")
          .replace(/^ {8}max_rounds: \d+$/mu, `        max_rounds: ${rounds}`),
      );

      const after = await readTeam(harness);
      if (described) {
        assert.equal(after.shape?.kind, "discussion", `${rounds} rounds`);
      } else {
        assert.equal(after.shape, undefined, `${rounds} rounds was described anyway`);
      }
      // The team stays readable either way.
      assert.ok(after.revision, `${rounds} rounds left the team unreadable`);
    });
  }
});

// Two authorized writes against the same file, arriving together. Each carries
// the revision it was written against, and the file is one thing: whoever is
// second is told the team moved, by name, rather than overwriting the first.
//
// Both are the module's own writers, so the two orders are the two orders that
// actually reach the lock. Driving one through HTTP would only prove which
// request was sent first.
test("a shape change and a roster change cannot both land on the same revision", async () => {
  for (const shapeFirst of [true, false]) {
    await withTeam(async (harness) => {
      const team = await readTeam(harness);
      const revision = team.revision ?? "";
      const agentDir = path.join(harness.repoRoot, "agents", "clause-clerk");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "clause-clerk.md"),
        "---\nname: clause-clerk\ndescription: clerk.\ntier: strategic\n---\n\n# clause-clerk\n",
      );

      const settle = async (write: Promise<unknown>) =>
        write.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      // Started in the order under test, with nothing awaited in between.
      const changing = () =>
        settle(
          changeSavedTeamShape({
            repoRoot: harness.repoRoot,
            teamId: TEAM_ID,
            shape: discussion,
            expectedRevision: revision,
          }),
        );
      const adding = () =>
        settle(
          addTeamBuilderAgents({
            repoRoot: harness.repoRoot,
            teamId: TEAM_ID,
            expectedRevision: revision,
            agents: [{ name: "clause-clerk" }],
          }),
        );
      const [first, second] = shapeFirst
        ? await Promise.all([changing(), adding()])
        : await Promise.all([adding(), changing()]);

      assert.equal(
        first.ok,
        true,
        `the first write was refused: ${
          first.ok ? "" : String(first.error)
        }`,
      );
      assert.equal(second.ok, false, "both writes landed on the same revision");
      // By name. Any other failure would mean the second write was refused for
      // some reason other than the team having moved.
      assert.ok(
        second.error instanceof TeamRevisionConflictError,
        `the loser was refused for the wrong reason: ${String(second.error)}`,
      );

      // And the file is the winner's, whole.
      const after = teamYaml(harness);
      assert.equal(after.includes("type: discussion"), shapeFirst);
      assert.equal(after.includes("clause-clerk"), !shapeFirst);
    });
  }
});

// A note written on the end of a setting is the author's, and so is a blank
// line they left for readability. Removing the setting removed both.
test("a note on a replaced setting, and the space around it, are the author's", async () => {
  await withTeam(
    async (harness) => {
      const team = await readTeam(harness);
      const answer = await changeShape(harness, {
        shape: discussion,
        expectedRevision: team.revision,
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));

      const after = teamYaml(harness);
      // The setting itself belongs to the old arrangement and goes.
      assert.doesNotMatch(after, /handoff_format/u);
      // What the author wrote beside it does not.
      assert.match(after, /# Markdown reads best in review\./u);
      // And the space they left before their nested note is still there.
      assert.match(after, /\n\n {8}# The order was argued about\./u);
    },
    [],
    {
      handoffLine: "        handoff_format: markdown  # Markdown reads best in review.",
      blankBeforeSequenceNote: true,
      sequenceNote: "        # The order was argued about.",
    },
  );
});

// A member the product keeps out of the UI is written to the file and hidden
// from every answer about the team. The shape route is an answer about the
// team, and it was the one writer that returned the roster raw.
test("a member hidden from the UI stays hidden when the shape is changed", async () => {
  await withTeam(
    async (harness) => {
      const team = await readTeam(harness);
      // The ordinary read hides it, which is the behaviour being matched.
      assert.deepEqual(
        (team.agents ?? []).map((agent) => agent.name),
        ["risk-lead"],
      );

      const answer = await changeShape(harness, {
        shape: discussion,
        expectedRevision: team.revision,
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const changed = answer.body.team as { agents: { name: string }[] };
      assert.deepEqual(
        changed.agents.map((agent) => agent.name),
        ["risk-lead"],
        "the shape route answered with a member every other route hides",
      );

      // And the member is still on disk, still in the stage that names it.
      const after = teamYaml(harness);
      assert.match(after, /name: "risk-spotter"/u);
      assert.match(after, /^ {8}- "risk-spotter"$/mu);
    },
    [],
    { hiddenAgent: "risk-spotter" },
  );
});

/**
 * A comment nobody indented is still inside the block it was written in.
 *
 * YAML puts no indentation contract on a comment, and people outdent them to
 * the margin so they stand out. Scanning for the end of a block by indentation
 * alone read the first such line as the end of the stage: the real `config:`
 * then sat outside what was being rewritten, and a second one was emitted
 * beside it. The write succeeded and the file was accepted, so the change
 * reported success — but with the settings split across two blocks the older
 * one won on read-back, and the depth just chosen was gone.
 */
test("an outdented comment inside the stage does not split it in two", async () => {
  await withTeam(
    async (harness) => {
      const team = await readTeam(harness);
      assert.equal(team.shape?.kind, "chain");

      const answer = await changeShape(harness, {
        shape: { ...discussion, depth: "thorough" },
        expectedRevision: team.revision,
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));

      const after = teamYaml(harness);
      // One stage and one config. A second config header is what this is
      // about: the settings split between them and the older block won.
      assert.equal(after.match(/^ {4}stage:/gmu)?.length, 1, after);
      assert.equal(after.match(/^ {6}config:/gmu)?.length, 1, after);

      // Read back through the product, not from the bytes: what the user
      // chose has to survive a fresh read, which is what stopped happening.
      const reread = await readTeam(harness);
      assert.equal(reread.shape?.kind, "discussion", JSON.stringify(reread));
      assert.equal(reread.shape?.depth, "thorough", JSON.stringify(reread));
      assert.equal(after.match(/^ {8}max_rounds: 5$/gmu)?.length, 1, after);

      // Every outdented note is still there, and so is everything around the
      // change that was never this operation's to touch.
      assert.match(after, /^# A note nobody indented\.$/mu);
      assert.match(after, /^ {4}# Another, indented to the level\.$/mu);
      assert.match(after, /^# Settings note at the margin\.$/mu);
      assert.match(after, /^ {4}# And one indented to the level\.$/mu);
      assert.match(after, /^ {8}constraints:$/mu);
      assert.match(after, /^ {10}user_review: true$/mu);
      assert.match(after, /^ {4}model: pinned\/lead-model$/mu);
    },
    [],
    {
      stageNotes: [
        "",
        "# A note nobody indented.",
        "    # Another, indented to the level.",
      ],
      configNotes: [
        "# Settings note at the margin.",
        "    # And one indented to the level.",
      ],
    },
  );
});

/**
 * The same file, changed to a review.
 *
 * A review's depth is written as `max_iterations`, and its refusal policy as
 * `on_max_iterations`. Both were among the settings lost when the block bounds
 * stopped early, so both are asserted from a fresh read rather than from the
 * bytes alone.
 */
test("an outdented comment does not cost a review its rounds or its policy", async () => {
  await withTeam(
    async (harness) => {
      const team = await readTeam(harness);
      const answer = await changeShape(harness, {
        shape: {
          kind: "review",
          rationale: "One writes, one checks.",
          depth: "standard",
          producer: "risk-lead",
          reviewer: "risk-spotter",
        },
        expectedRevision: team.revision,
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));

      const after = teamYaml(harness);
      assert.equal(after.match(/^ {6}config:/gmu)?.length, 1, after);
      assert.equal(after.match(/^ {8}max_iterations: 3$/gmu)?.length, 1, after);
      assert.equal(
        after.match(/^ {8}on_max_iterations: escalate_to_user$/gmu)?.length,
        1,
        after,
      );
      // The chain's own setting goes; it describes an arrangement this team no
      // longer has.
      assert.doesNotMatch(after, /handoff_format/u);

      const reread = await readTeam(harness);
      assert.equal(reread.shape?.kind, "review", JSON.stringify(reread));
      assert.equal(reread.shape?.depth, "standard", JSON.stringify(reread));
      assert.match(after, /^# A note nobody indented\.$/mu);
      assert.match(after, /^# Settings note at the margin\.$/mu);
    },
    [],
    {
      stageNotes: ["", "# A note nobody indented."],
      configNotes: ["# Settings note at the margin."],
    },
  );
});

/**
 * The same note, written between two members of the sequence.
 *
 * A list item is nested one level deeper than the key that holds it, so a
 * margin comment here is further outdented still — and it sits in the middle of
 * the very block this change removes and rewrites. A blank line before it is
 * ordinary: that is how people separate a note from what it follows.
 */
test("an outdented comment between sequence members keeps the shape readable", async () => {
  await withTeam(
    async (harness) => {
      const team = await readTeam(harness);
      const answer = await changeShape(harness, {
        shape: { ...discussion, depth: "quick" },
        expectedRevision: team.revision,
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));

      const after = teamYaml(harness);
      assert.equal(after.match(/^ {4}stage:/gmu)?.length, 1, after);
      assert.equal(after.match(/^ {6}config:/gmu)?.length, 1, after);
      // The answer was 200 while the file it wrote had already lost the choice,
      // so the read-back is the assertion that matters.
      const reread = await readTeam(harness);
      assert.equal(reread.shape?.kind, "discussion", JSON.stringify(reread));
      assert.equal(reread.shape?.depth, "quick", JSON.stringify(reread));
      // The note is the author's, wherever they put it.
      assert.match(after, /^# Argued about, at the margin\.$/mu);
      // And the members it sat between are gone with the arrangement that had
      // them, not left behind as an orphaned list.
      assert.doesNotMatch(after, /^ {6}sequence:$/mu);
    },
    [],
    {
      blankBeforeSequenceNote: true,
      sequenceNote: "# Argued about, at the margin.",
    },
  );
});

/**
 * A note at the margin directly before the next top-level block.
 *
 * The other half of the same rule. A comment run that is followed by something
 * outside the block belongs to what comes next, and must not be pulled into
 * the stage — which would move it above `gates:` and change what it annotates.
 */
test("a note before the next block stays with the block it introduces", async () => {
  await withTeam(
    async (harness) => {
      const team = await readTeam(harness);
      const answer = await changeShape(harness, {
        shape: discussion,
        expectedRevision: team.revision,
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));

      const after = teamYaml(harness);
      // Still immediately above the gates, with the stage rewritten above it.
      assert.match(after, /# What finishes the run\.\ngates:/u);
      assert.equal(after.match(/# What finishes the run\./gu)?.length, 1, after);
      const reread = await readTeam(harness);
      assert.equal(reread.shape?.kind, "discussion", JSON.stringify(reread));
    },
    [],
    { noteBeforeGates: ["", "# What finishes the run."] },
  );
});

// The same boundary the plan route answers, stated here so the two cannot
// drift apart again: a request that never said which version it was written
// against is incomplete, and a string that is merely out of date is a conflict.
test("a change that says no revision is refused as incomplete, not as stale", async () => {
  await withTeam(async (harness) => {
    const before = teamYaml(harness);
    for (
      const body of [
        { shape: discussion },
        { shape: discussion, expectedRevision: null },
        { shape: discussion, expectedRevision: 7 },
      ]
    ) {
      const answer = await changeShape(harness, body);
      assert.equal(
        answer.status,
        400,
        `${JSON.stringify(body)} -> ${JSON.stringify(answer.body)}`,
      );
      assert.equal(answer.body.error, "missing_revision");
      assert.equal(typeof answer.body.reason, "string");
    }
    assert.equal(teamYaml(harness), before, "an incomplete request wrote to the file");

    const stale = await changeShape(harness, {
      shape: discussion,
      expectedRevision: `sha256:${"0".repeat(64)}`,
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(teamYaml(harness), before, "a stale request wrote to the file");
  });
});
