import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import {
  discardStagedPlannedAgent,
  persistPlannedAgentDraft,
} from "../../domains/agent-generator/planned-agent-persistence.js";
import {
  buildPlannedAgents,
  createFallbackSkill,
} from "../../domains/agent-generator/planned-agent-builder.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import {
  createResourceBuildSnapshot,
  runResourceBuild,
} from "../../services/resource-architect-service.js";
import {
  readTeamBuilderTeam,
  updateTeamBuilderTeam,
} from "../../domains/agent-generator/team-manager.js";
import { renderResourceArchitectPlannedAgentBrief } from "../../domains/resource-architect/planned-agent-brief.js";
import type { ResourceArchitectPlan } from "../../contracts/resource-architect.js";

function withTempRepo(fn: (repoRoot: string) => void | Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "team-build-recovery-"));
  fs.mkdirSync(path.join(repoRoot, "agents"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  return Promise.resolve(fn(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
}

function draftParams(repoRoot: string) {
  return {
    repoRoot,
    orchestratorKey: "plan-1:create-team",
    requestedName: "art-critic",
    personaMarkdown:
      "---\nname: art-critic\ndescription: Reviews art.\ntier: execution\n---\n\n# Art Critic\n",
    generatedSkills: [
      {
        name: "art-critique",
        body:
          "---\nname: art-critique\ndescription: Reviews visual work. Use when a piece needs a structured critique.\n---\n\n# Art Critique\n",
      },
    ],
  };
}

test("resource Architect planned Agent briefs preserve document-specialist scope", () => {
  const team = {
    teamId: "tissue-adhesive-diligence",
    description: "Technically diligences an electrical tissue adhesive.",
    tags: ["technical-diligence"],
    documentDomains: [{
      domain: "Hydrogel tissue-interface mechanics",
      evidenceAnchors: ["PAAC-NHS + gelatin network"],
    }],
    existingAgents: [],
    newAgents: [{
      name: "soft-tissue-hydrogel-mechanics-specialist",
      role: "Assess adhesive chemistry and mechanical failure modes.",
      description: "Evaluates the PAAC-NHS/gelatin tissue interface and fracture behavior.",
      rationale: "No existing agent evaluates this tissue-interface system.",
      documentSpecialization: {
        expertiseDomain: "Soft-tissue hydrogel mechanics",
        focus: "PAAC-NHS/gelatin tissue-interface mechanics and adhesion chemistry.",
        evidenceAnchors: ["PAAC-NHS + gelatin network", "fracture toughness"],
        assessmentTargets: ["adhesion mechanism", "hydration-linked mechanical failure"],
        outOfScope: ["General biomaterials market analysis"],
      },
    }],
    questionsResolved: [],
  };

  const brief = renderResourceArchitectPlannedAgentBrief(team, team.newAgents[0]!);

  assert.match(brief, /Agent persona brief: Evaluates the PAAC-NHS\/gelatin tissue interface/);
  assert.match(brief, /Document domains this team must cover:/);
  assert.match(brief, /Established expertise domain: Soft-tissue hydrogel mechanics/);
  assert.match(brief, /Document-specific focus: PAAC-NHS\/gelatin tissue-interface mechanics/);
  assert.match(brief, /Evidence anchors: PAAC-NHS \+ gelatin network; fracture toughness/);
  assert.match(brief, /Assessment targets: adhesion mechanism; hydration-linked mechanical failure/);
  assert.match(brief, /Out of scope: General biomaterials market analysis/);
});

test("resource Team build follows a saved Team rename before binding a generated Agent", async () => {
  await withTempRepo(async (repoRoot) => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    const initialTeamId = "startup-diligence-board";
    const renamedTeamId = "agridynamics-diligence-board";
    const agentName = "cross-domain-application-scout";
    let renamed = false;
    const provider = http.createServer((request, response) => {
      void (async () => {
        for await (const _chunk of request) {
          // Consume the real OpenAI-compatible request before responding.
        }
        await updateTeamBuilderTeam(repoRoot, initialTeamId, {
          id: renamedTeamId,
          description: "Reviews a startup with multiple diligence lenses.",
          tags: ["diligence"],
        });
        renamed = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          model: "test-model",
          choices: [{ message: { content: JSON.stringify({
            message: "Created the requested Agent.",
            suggestedName: agentName,
            personaMarkdown: [
              "---",
              `name: ${agentName}`,
              "description: Finds adjacent applications.",
              "tier: strategic",
              "---",
              "",
              "# Cross-domain Application Scout",
            ].join("\n"),
            generatedSkills: [{
              name: "application-scout-method",
              body: "---\nname: application-scout-method\ndescription: Scout method. Use when a technology needs adjacent applications identified.\n---\n\n# Method\n",
            }],
          }) } }],
        }));
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    assert.ok(address && typeof address === "object");
    process.env.OPENAI_API_KEY = "test-key";
    process.env.WORKFLOW_GENERATOR_OPENAI_API_URL =
      `http://127.0.0.1:${address.port}/v1/chat/completions`;
    fs.mkdirSync(path.join(repoRoot, "teams", "workflow-architect"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "agents", "workflow-architect"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "teams", "workflow-architect", "team.yaml"),
      [
        "agents:",
        "  - agent_file: ../../agents/workflow-architect/workflow-architect.md",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repoRoot, "agents", "workflow-architect", "workflow-architect.md"),
      ["---", "provider: openai", "model: test-model", "---", "", "Create an Agent package.", ""].join("\n"),
    );
    const plan: Extract<ResourceArchitectPlan, { kind: "team" }> = {
      id: "rename-aware-resource-plan",
      kind: "team",
      team: {
        teamId: initialTeamId,
        description: "Reviews a startup with multiple diligence lenses.",
        tags: ["diligence"],
        existingAgents: [],
        newAgents: [{
          name: agentName,
          description: "Finds adjacent applications for a technology.",
          role: "Identify adjacent markets and transfer constraints.",
          rationale: "The Team needs a dedicated transfer lens.",
        }],
        questionsResolved: [],
      },
    };
    const job = createResourceBuildSnapshot({ plan, jobId: "rename-aware-job" });

    try {
      await runResourceBuild({
        repoRoot,
        plan,
        job,
        store: new ResourceArchitectStore(),
        provider: "openai",
        model: "test-model",
      });

      assert.equal(renamed, true);
      assert.equal(job.status, "completed", job.error);
      assert.deepEqual(job.selectedResource, { kind: "team", id: renamedTeamId });
      assert.deepEqual(
        readTeamBuilderTeam(repoRoot, renamedTeamId).agents.map((agent) => agent.name),
        [agentName],
      );
      assert.equal(job.events.some((event) => event.type === "team_renamed"), true);
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
      if (originalApiUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
      else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = originalApiUrl;
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => error ? reject(error) : resolve()),
      );
    }
  });
});


test("fallback skill names preserve the complete method suffix within the name limit", () => {
  const skill = createFallbackSkill({
    name: "1234567890123456789012345678901234567890",
    role: "Reviewer",
    description: "Reviews long identifiers.",
    rationale: "Requested by the user.",
  });

  assert.equal(skill.name, "123456789012345678901234567890123-method");
  assert.equal(skill.name.length, 40);
});

test("a published Agent reports reservation cleanup failure without losing success", async () => {
  await withTempRepo(async (repoRoot) => {
    const consoleOutput: unknown[][] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => consoleOutput.push(args);
    console.error = (...args: unknown[]) => consoleOutput.push(args);
    try {
      const result = await buildPlannedAgents({
        repoRoot,
        planId: "cleanup-plan",
        jobId: "cleanup-job",
        agents: [{
          name: "cleanup-agent",
          role: "Cleanup observer",
          description: "Verifies post-publication cleanup reporting.",
          rationale: "Publication must remain successful after cleanup fails.",
        }],
        maxConcurrency: 1,
        allowFallback: true,
        onUpdate(update) {
          if (update.eventType !== "agent_created") return;
          const reservationDir = path.join(
            repoRoot,
            ".create-orchestrator",
            "agent-name-reservations",
          );
          const [receiptName] = fs.readdirSync(reservationDir);
          assert.ok(receiptName);
          const receiptPath = path.join(reservationDir, receiptName);
          const receipt: unknown = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
          assert.ok(typeof receipt === "object" && receipt !== null);
          fs.writeFileSync(
            receiptPath,
            `${JSON.stringify({ ...receipt, jobId: "another-job" })}\n`,
          );
        },
      });

      // The Agent really was published, so its own outcome stays successful.
      // The name it could not give back is reported beside it, never onto it.
      assert.equal(result.items[0]?.status, "created");
      assert.equal(result.items[0]?.error, undefined);
      assert.equal(result.cleanupIssues.length, 1);
      assert.match(String(result.cleanupIssues[0]), /cleanup-agent.*could not be released/);
      assert.deepEqual(
        consoleOutput,
        [],
        "cleanup failure is returned as evidence, not written to the console",
      );
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });
});

test("a post-publication persistence notification failure does not reclassify a created Agent", async () => {
  await withTempRepo(async (repoRoot) => {
    const result = await buildPlannedAgents({
      repoRoot,
      planId: "post-publish-update-plan",
      jobId: "post-publish-update-job",
      agents: [{
        name: "durable-created-agent",
        role: "Persistence observer",
        description: "Verifies terminal Agent status survives a store write failure.",
        rationale: "Publication has already completed before the notification write.",
      }],
      maxConcurrency: 1,
      allowFallback: true,
      onUpdate(update) {
        if (update.eventType === "agent_created") {
          throw new Error("simulated durable job save failure");
        }
      },
    });

    assert.equal(result.items[0]?.status, "created");
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", "durable-created-agent")),
      true,
    );
  });
});

test("Agent build outcomes survive failed persistence notifications at every lifecycle event", async () => {
  await withTempRepo(async (repoRoot) => {
    const result = await buildPlannedAgents({
      repoRoot,
      planId: "all-notifications-fail-plan",
      jobId: "all-notifications-fail-job",
      agents: [{
        name: "notification-resilient-agent",
        role: "Persistence observer",
        description: "Verifies event persistence cannot change build outcomes.",
        rationale: "Event delivery follows the state transition rather than defining it.",
      }],
      maxConcurrency: 1,
      allowFallback: true,
      onUpdate() {
        throw new Error("simulated durable job save failure");
      },
    });

    assert.equal(result.items[0]?.status, "created");
  });
});

test("standalone resource builds publish fallback drafts like Team resource builds", async () => {
  await withTempRepo(async (repoRoot) => {
    const plan = {
      id: "standalone-fallback-plan",
      kind: "standalone_agents" as const,
      agents: [{
        name: "fallback-standalone-agent",
        role: "Fallback observer",
        description: "Verifies standalone fallback publication.",
        rationale: "Both resource creation paths must treat fallback drafts alike.",
      }],
    };
    const job = createResourceBuildSnapshot({ plan, jobId: "standalone-fallback-job" });

    await runResourceBuild({
      repoRoot,
      plan,
      job,
      store: new ResourceArchitectStore(),
    });

    assert.equal(job.status, "completed");
    assert.equal(job.items[0]?.status, "created");
  });
});

test("standalone resource builds persist terminal Agent updates without writing every interim event", async () => {
  await withTempRepo(async (repoRoot) => {
    const plan = {
      id: "batched-build-updates-plan",
      kind: "standalone_agents" as const,
      agents: [{
        name: "batched-build-updates-agent",
        role: "Persistence observer",
        description: "Verifies durable writes are limited to terminal Agent updates.",
        rationale: "Polling can read transient state from memory until publication completes.",
      }],
    };
    const job = createResourceBuildSnapshot({ plan, jobId: "batched-build-updates-job" });
    const memoryStore = new ResourceArchitectStore();
    const savedSnapshots: typeof job[] = [];

    await runResourceBuild({
      repoRoot,
      plan,
      job,
      store: {
        savePlan: (candidate) => memoryStore.savePlan(candidate),
        getPlan: (planId) => memoryStore.getPlan(planId),
        claimPlan: (planId) => memoryStore.claimPlan(planId),
        saveJob: async (candidate) => {
          savedSnapshots.push(JSON.parse(JSON.stringify(candidate)));
          await memoryStore.saveJob(candidate);
        },
        getJob: (jobId) => memoryStore.getJob(jobId),
        listJobs: () => memoryStore.listJobs(),
      },
    });

    assert.equal(savedSnapshots.length, 2);
    assert.equal(savedSnapshots[0]?.items[0]?.status, "created");
    assert.equal(savedSnapshots[1]?.status, "completed");
  });
});

test("planned agent retry replaces an unpublished commit that failed before its ready receipt", async () => {
  await withTempRepo(async (repoRoot) => {
    await assert.rejects(
      persistPlannedAgentDraft({
        ...draftParams(repoRoot),
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_files_staged") {
            throw new Error("simulated process loss after agent commit");
          }
        },
      }),
      /simulated process loss after agent commit/,
    );

    assert.equal(fs.existsSync(path.join(repoRoot, "agents", "art-critic")), false);

    const recoveredName = await persistPlannedAgentDraft({
      ...draftParams(repoRoot),
      personaMarkdown:
        "---\nname: art-critic\ndescription: Recovered review agent.\ntier: execution\n---\n\n# Recovered Art Critic\n",
    });

    assert.equal(recoveredName, "art-critic");
    assert.match(
      fs.readFileSync(path.join(repoRoot, "agents", "art-critic", "art-critic.md"), "utf8"),
      /Recovered Art Critic/,
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, ".create-orchestrator", "staged-agents")),
      false,
    );
  });
});

test("planned agent retry publishes the exact ready stage after failure before its marker", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss before ownership marker");
          }
        },
      }),
      /simulated process loss before ownership marker/,
    );

    const recoveredName = await persistPlannedAgentDraft({
      ...original,
      personaMarkdown: "# This replacement must not be committed\n",
    });
    const agentPath = path.join(repoRoot, "agents", recoveredName);

    assert.equal(recoveredName, "art-critic");
    assert.equal(
      fs.readFileSync(path.join(agentPath, "art-critic.md"), "utf8"),
      original.personaMarkdown,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(agentPath, ".create-orchestrator"), "utf8")),
      {
        orchestratorKey: original.orchestratorKey,
        requestedName: original.requestedName,
      },
    );
  });
});

test("planned agent retry reuses a published agent after failure before roster binding", async () => {
  await withTempRepo(async (repoRoot) => {
    const input = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...input,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_published") {
            throw new Error("simulated process loss after publish");
          }
        },
      }),
      /simulated process loss after publish/,
    );

    assert.equal(fs.existsSync(path.join(repoRoot, "agents", "art-critic")), true);
    assert.equal(await persistPlannedAgentDraft(input), "art-critic");
    assert.deepEqual(
      fs.readdirSync(path.join(repoRoot, "agents")).filter((name) =>
        name.startsWith("art-critic"),
      ),
      ["art-critic"],
    );
  });
});

test("planned Agent retry reads its exact ownership marker without listing sibling Agents", async () => {
  await withTempRepo(async (repoRoot) => {
    const input = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...input,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_published") {
            throw new Error("simulated process loss after publish");
          }
        },
      }),
      /simulated process loss after publish/,
    );
    fs.mkdirSync(path.join(repoRoot, "agents", "unrelated-agent"));
    const agentsRoot = path.join(repoRoot, "agents");
    fs.chmodSync(agentsRoot, 0o111);
    try {
      assert.equal(await persistPlannedAgentDraft(input), "art-critic");
    } finally {
      fs.chmodSync(agentsRoot, 0o755);
    }
  });
});


test("concurrent retries publish one owned agent", async () => {
  await withTempRepo(async (repoRoot) => {
    const [first, second] = await Promise.all([
      persistPlannedAgentDraft(draftParams(repoRoot)),
      persistPlannedAgentDraft(draftParams(repoRoot)),
    ]);

    assert.equal(first, "art-critic");
    assert.equal(second, "art-critic");
    assert.deepEqual(fs.readdirSync(path.join(repoRoot, "agents")), ["art-critic"]);
  });
});

test("planned agent persistence rejects an unrelated public folder collision", async () => {
  await withTempRepo(async (repoRoot) => {
    const unrelated = path.join(repoRoot, "agents", "art-critic");
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, "art-critic.md"), "# Unrelated agent\n");

    await assert.rejects(
      persistPlannedAgentDraft(draftParams(repoRoot)),
      /Agent folder already exists/,
    );
    assert.deepEqual(fs.readdirSync(path.join(repoRoot, "agents")), ["art-critic"]);
  });
});

test("a ready staged package with no ownership marker is recovered with one", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss after the ready receipt");
          }
        },
      }),
      /simulated process loss after the ready receipt/,
    );
    // The marker is removed to model an interrupted marker write beside a
    // package the receipt already calls complete.
    const stagedRoot = path.join(repoRoot, ".create-orchestrator", "staged-agents");
    const [transaction] = fs.readdirSync(stagedRoot).filter((entry) => !entry.startsWith("."));
    assert.ok(transaction);
    const markerPath = path.join(
      stagedRoot,
      transaction,
      "repo",
      "agents",
      "art-critic",
      ".create-orchestrator",
    );
    assert.equal(fs.existsSync(markerPath), true, "fixture check: the marker was written");
    fs.rmSync(markerPath);

    const recoveredName = await persistPlannedAgentDraft(original);

    const published = path.join(repoRoot, "agents", recoveredName, ".create-orchestrator");
    assert.deepEqual(JSON.parse(fs.readFileSync(published, "utf8")), {
      orchestratorKey: original.orchestratorKey,
      requestedName: original.requestedName,
    });
  });
});

test("a ready staged package whose marker names another build is refused", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss after the ready receipt");
          }
        },
      }),
      /simulated process loss after the ready receipt/,
    );
    const stagedRoot = path.join(repoRoot, ".create-orchestrator", "staged-agents");
    const [transaction] = fs.readdirSync(stagedRoot).filter((entry) => !entry.startsWith("."));
    assert.ok(transaction);
    fs.writeFileSync(
      path.join(stagedRoot, transaction, "repo", "agents", "art-critic", ".create-orchestrator"),
      `${JSON.stringify({ orchestratorKey: "someone-else", requestedName: "art-critic" })}\n`,
    );

    await assert.rejects(persistPlannedAgentDraft(original), /ownership does not match/);
  });
});

test("a staged transaction whose receipt is unreadable is reported, not skipped", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss after the ready receipt");
          }
        },
      }),
      /simulated process loss after the ready receipt/,
    );
    const stagedRoot = path.join(repoRoot, ".create-orchestrator", "staged-agents");
    const [transaction] = fs.readdirSync(stagedRoot).filter((entry) => !entry.startsWith("."));
    assert.ok(transaction);
    fs.writeFileSync(path.join(stagedRoot, transaction, "receipt.json"), "{ not json\n");

    await assert.rejects(persistPlannedAgentDraft(original), new RegExp(transaction));
  });
});

test("a ready staged package whose marker is unreadable is refused", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss after the ready receipt");
          }
        },
      }),
      /simulated process loss after the ready receipt/,
    );
    const staged = stagedAgentPackage(repoRoot, "art-critic");
    fs.writeFileSync(path.join(staged, ".create-orchestrator"), "{ not json\n");

    await assert.rejects(persistPlannedAgentDraft(original), /unreadable ownership marker/);
  });
});

test("a ready staged package whose persona names another Agent is refused", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss after the ready receipt");
          }
        },
      }),
      /simulated process loss after the ready receipt/,
    );
    const staged = stagedAgentPackage(repoRoot, "art-critic");
    const markerPath = path.join(staged, ".create-orchestrator");
    fs.rmSync(markerPath);
    fs.writeFileSync(
      path.join(staged, "art-critic.md"),
      "---\nname: someone-else\ndescription: Not this Agent.\n---\n",
    );

    await assert.rejects(persistPlannedAgentDraft(original), /does not name/);
    assert.equal(
      fs.existsSync(markerPath),
      false,
      "a package whose identity does not check out must not be given a marker",
    );
  });
});

/** The staged package directory for `agentName` in the one open transaction. */
function stagedAgentPackage(repoRoot: string, agentName: string): string {
  const stagedRoot = path.join(repoRoot, ".create-orchestrator", "staged-agents");
  const [transaction] = fs
    .readdirSync(stagedRoot)
    .filter((entry) => !entry.startsWith("."));
  assert.ok(transaction);
  return path.join(stagedRoot, transaction, "repo", "agents", agentName);
}

test("a staged receipt whose names disagree cannot publish another Agent", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss after the ready receipt");
          }
        },
      }),
      /simulated process loss after the ready receipt/,
    );
    const stagedRoot = path.join(repoRoot, ".create-orchestrator", "staged-agents");
    const [transaction] = fs
      .readdirSync(stagedRoot)
      .filter((entry) => !entry.startsWith("."));
    assert.ok(transaction);
    const receiptPath = path.join(stagedRoot, transaction, "receipt.json");
    const receipt: unknown = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.ok(typeof receipt === "object" && receipt !== null);
    // A receipt that requests one Agent and names another must never be usable
    // to publish the second under the first one's request.
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, agentName: "some-other-agent" })}\n`,
    );

    await assert.rejects(persistPlannedAgentDraft(original), new RegExp(transaction));
  });
});

test("a ready staged package with a valid marker but a mutated persona is refused", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss after the ready receipt");
          }
        },
      }),
      /simulated process loss after the ready receipt/,
    );
    const staged = stagedAgentPackage(repoRoot, "art-critic");
    // The marker is left exactly as this build wrote it: ownership is intact
    // and only the content identity is wrong.
    assert.equal(fs.existsSync(path.join(staged, ".create-orchestrator")), true);
    fs.writeFileSync(
      path.join(staged, "art-critic.md"),
      "---\nname: someone-else\ndescription: Not this Agent.\n---\n",
    );

    await assert.rejects(persistPlannedAgentDraft(original), /does not name/);
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", "art-critic")),
      false,
      "a package whose content identity is wrong must not be published",
    );
  });
});

test("an abandoned empty transaction shell is cleaned up rather than kept forever", async () => {
  await withTempRepo(async (repoRoot) => {
    const stagedRoot = path.join(repoRoot, ".create-orchestrator", "staged-agents");
    const shell = path.join(stagedRoot, "abandoned-empty-transaction");
    fs.mkdirSync(shell, { recursive: true });

    const name = await persistPlannedAgentDraft(draftParams(repoRoot));

    assert.equal(name, "art-critic");
    assert.equal(
      fs.existsSync(shell),
      false,
      "an inactive transaction with no receipt and no payload is discarded",
    );
  });
});

test("a ready receipt whose package persona is gone is reported, not skipped", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss after the ready receipt");
          }
        },
      }),
      /simulated process loss after the ready receipt/,
    );
    const stagedRoot = path.join(repoRoot, ".create-orchestrator", "staged-agents");
    const [transaction] = fs
      .readdirSync(stagedRoot)
      .filter((entry) => !entry.startsWith("."));
    assert.ok(transaction);
    fs.rmSync(stagedAgentPackage(repoRoot, "art-critic"), { recursive: true, force: true });

    // A ready receipt is a committed claim on the name. Silently starting a
    // second transaction would leave the broken evidence in place.
    await assert.rejects(persistPlannedAgentDraft(original), new RegExp(transaction));
  });
});

test("staged evidence follows plan order even when generations finish in reverse", async () => {
  await withTempRepo(async (repoRoot) => {
    const secondStaged = deferredSignal();
    let firstHeld = false;
    let secondStagedWhileFirstHeld = false;

    const result = await buildPlannedAgents({
      repoRoot,
      planId: "ordering-plan",
      jobId: "ordering-job",
      publication: "stage",
      agents: [
        {
          name: "first-planned-agent",
          role: "First",
          description: "Planned first.",
          rationale: "Ordering evidence.",
        },
        {
          name: "second-planned-agent",
          role: "Second",
          description: "Planned second.",
          rationale: "Ordering evidence.",
        },
      ],
      maxConcurrency: 2,
      allowFallback: true,
      onPersistenceBoundary(boundary) {
        // While the first plan entry is held before generation, the only
        // package that can be reaching a ready receipt is the second one.
        if (boundary === "after_agent_ready_receipt" && firstHeld) {
          secondStagedWhileFirstHeld = true;
          secondStaged.resolve();
        }
      },
      async onUpdate(update) {
        if (
          update.item.plannedResource.id === "first-planned-agent" &&
          update.eventType === "agent_generating" &&
          !firstHeld
        ) {
          firstHeld = true;
          await secondStaged.promise;
        }
      },
    });

    assert.equal(
      secondStagedWhileFirstHeld,
      true,
      "fixture check: the second package finished staging before the first began",
    );
    assert.deepEqual(
      result.staged.map((entry) => entry.agentName),
      ["first-planned-agent", "second-planned-agent"],
      "staged evidence is ordered by plan index, not by which package finished first",
    );
    // Each package still holds its own Agent, not the other one's.
    for (const entry of result.staged) {
      assert.ok(entry.stagedAgentPath);
      const persona = fs.readFileSync(
        path.join(entry.stagedAgentPath, `${entry.agentName}.md`),
        "utf8",
      );
      assert.match(persona, new RegExp(`name:\\s*${entry.agentName}`));
    }
  });
});

/** A promise a test resolves explicitly, with no non-null assertion. */
function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle?.() };
}

test("discarding a staged transaction refuses evidence that is not this exact ready package", async () => {
  await withTempRepo(async (repoRoot) => {
    const original = draftParams(repoRoot);
    await assert.rejects(
      persistPlannedAgentDraft({
        ...original,
        onPersistenceBoundary(boundary) {
          if (boundary === "after_agent_ready_receipt") {
            throw new Error("simulated process loss after the ready receipt");
          }
        },
      }),
      /simulated process loss after the ready receipt/,
    );
    const stagedRoot = path.join(repoRoot, ".create-orchestrator", "staged-agents");
    const [transaction] = fs
      .readdirSync(stagedRoot)
      .filter((entry) => !entry.startsWith("."));
    assert.ok(transaction);
    const transactionRoot = path.join(stagedRoot, transaction);
    const receiptPath = path.join(transactionRoot, "receipt.json");
    const receipt: unknown = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.ok(typeof receipt === "object" && receipt !== null);

    // Still building: not the completed package this caller means to discard.
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, state: "building" })}\n`);
    assert.equal(
      await discardStagedPlannedAgent({
        repoRoot,
        orchestratorKey: original.orchestratorKey,
        requestedName: original.requestedName,
        transactionRoot,
      }),
      false,
      "a transaction that is not ready is preserved",
    );
    assert.equal(fs.existsSync(transactionRoot), true);

    // Ready, but naming a different Agent than the one requested.
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, state: "ready", agentName: "another-agent" })}\n`,
    );
    assert.equal(
      await discardStagedPlannedAgent({
        repoRoot,
        orchestratorKey: original.orchestratorKey,
        requestedName: original.requestedName,
        transactionRoot,
      }),
      false,
      "a transaction whose names disagree is preserved",
    );
    assert.equal(fs.existsSync(transactionRoot), true);

    // The exact ready package this caller owns is discarded.
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    assert.equal(
      await discardStagedPlannedAgent({
        repoRoot,
        orchestratorKey: original.orchestratorKey,
        requestedName: original.requestedName,
        transactionRoot,
      }),
      true,
    );
    assert.equal(fs.existsSync(transactionRoot), false);
  });
});
