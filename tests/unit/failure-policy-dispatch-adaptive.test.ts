/**
 * Adaptive Failure Policy Dispatch Tests
 *
 * Tests dispatchWithFailurePolicy with:
 *   - ProviderError retryable classification
 *   - Circuit breaker integration
 *   - Budget-aware retry reduction
 *   - Exponential backoff timing
 *
 * Uses mock.module to inject a fake dispatchToAgentOrTeam.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mock } from "node:test";

import type { DispatchOptions } from "../../domains/agent-execution/agent-runner.js";
import { ProviderError } from "../../domains/provider/provider-error.js";
import { BudgetLedger } from "../../core/budget-ledger.js";

// Mutable implementation that tests can swap
let dispatchImpl: (
  options: DispatchOptions,
) => Promise<{ text: string; cost: number; model?: string }> = async () => {
  throw new Error("default mock");
};

let circuitCheckImpl: (provider: string) => { allowed: boolean; reason?: string } = () => ({ allowed: true });
let circuitFailureCount = 0;

mock.module("../../domains/agent-execution/agent-runner.js", {
  namedExports: {
    dispatchToAgentOrTeam: mock.fn(async (options: DispatchOptions) =>
      dispatchImpl(options),
    ),
  },
});

mock.module("../../domains/runtime/circuit-breaker.js", {
  namedExports: {
    globalCircuitBreaker: {
      check: (provider: string) => circuitCheckImpl(provider),
      recordSuccess: () => {},
      recordFailure: () => { circuitFailureCount += 1; },
    },
  },
});

const {
  dispatchWithFailurePolicy,
  computeRetryDelay,
  getBudgetAdjustedMaxRetries,
  HaltError,
  DispatchResultValidationError,
  waitForRetryDelay,
} = await import("../../domains/agent-execution/failure-policy.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-adaptive-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeAgent(name: string, provider = "anthropic") {
  return {
    name,
    model: "claude-test",
    thinking: "medium" as const,
    systemPrompt: "test",
    experienceContent: "",
    experienceEnabled: false,
    skillsContent: "",
    knowledgeContent: "",
    selection: null,
    agentDir: "/tmp",
    color: 36,
    provider,
    providerConfig: {},
  };
}

function makeBaseOptions(dir: string) {
  return {
    agent: makeAgent("test-agent"),
    rosterEntry: undefined,
    finalPrompt: "test",
    userMessage: "hello",
    state: {
      sessionId: "sess-1",
      currentLevelIndex: 0,
      levelStates: new Map(),
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: 0,
    },
    workspacePath: dir,
    outputPath: dir,
    inputFilesContent: "",
    metrics: undefined,
  };
}

// ─── computeRetryDelay ───────────────────────────────────────────────────────

test("computeRetryDelay: first retry uses base + jitter", () => {
  const delay = computeRetryDelay(1);
  assert.ok(delay >= 1000 && delay <= 1500, `delay=${delay}`);
});

test("computeRetryDelay: second retry doubles base", () => {
  const delay = computeRetryDelay(2);
  assert.ok(delay >= 2000 && delay <= 2500, `delay=${delay}`);
});

test("computeRetryDelay: caps at max", () => {
  const delay = computeRetryDelay(10);
  assert.ok(delay <= 30000, `delay=${delay}`);
});

test("computeRetryDelay: honors retryAfterMs", () => {
  const delay = computeRetryDelay(1, 5000);
  assert.equal(delay, 5000);
});

test("waitForRetryDelay: aborts immediately instead of waiting for retry backoff", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const waiting = waitForRetryDelay(30_000, controller.signal);
  controller.abort(new Error("cancelled"));

  await assert.rejects(waiting, /cancelled/);
  assert.ok(Date.now() - startedAt < 500, "abort must not wait for the configured backoff");
});

// ─── getBudgetAdjustedMaxRetries ─────────────────────────────────────────────

test("getBudgetAdjustedMaxRetries: no budget → unchanged", () => {
  const result = getBudgetAdjustedMaxRetries(3, undefined, undefined);
  assert.equal(result, 3);
});

test("getBudgetAdjustedMaxRetries: under threshold → unchanged", () => {
  const ledger = {
    capUsd: 100,
    policy: "warn" as const,
    canDispatch: () => ({ allowed: true }),
  } as unknown as BudgetLedger;
  const result = getBudgetAdjustedMaxRetries(3, ledger, 80);
  assert.equal(result, 3);
});

test("getBudgetAdjustedMaxRetries: at 90% threshold → reduces to 1", () => {
  const ledger = {
    capUsd: 100,
    policy: "warn" as const,
    canDispatch: () => ({ allowed: true }),
  } as unknown as BudgetLedger;
  const result = getBudgetAdjustedMaxRetries(3, ledger, 90);
  assert.equal(result, 1);
});

test("getBudgetAdjustedMaxRetries: over 90% threshold → reduces to 1", () => {
  const ledger = {
    capUsd: 100,
    policy: "warn" as const,
    canDispatch: () => ({ allowed: false }),
  } as unknown as BudgetLedger;
  const result = getBudgetAdjustedMaxRetries(5, ledger, 95);
  assert.equal(result, 1);
});

test("getBudgetAdjustedMaxRetries: already 1 → stays 1", () => {
  const ledger = {
    capUsd: 100,
    policy: "warn" as const,
    canDispatch: () => ({ allowed: false }),
  } as unknown as BudgetLedger;
  const result = getBudgetAdjustedMaxRetries(1, ledger, 95);
  assert.equal(result, 1);
});

// ─── ProviderError non-retryable escalates immediately ───────────────────────

test("dispatchWithFailurePolicy: non-retryable ProviderError escalates without retries", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    dispatchImpl = async () => {
      calls++;
      throw new ProviderError({
        provider: "anthropic",
        message: "auth failed",
        statusCode: 401,
        retryable: false,
      });
    };

    try {
      await dispatchWithFailurePolicy({
        ...makeBaseOptions(dir),
        policy: { policy: "retry", maxRetries: 3 },
        levelId: "l1",
        stageType: "pipeline",
        sessionId: "s1",
        errorLogPath: dir,
      });
      assert.fail("expected HaltError");
    } catch (err) {
      assert.ok(err instanceof HaltError);
      assert.match(err.originalError, /auth failed/);
    }

    assert.equal(calls, 1, "non-retryable error should not waste retries");
    const logPath = path.join(dir, "agent-errors.jsonl");
    const lines = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map(({ error_type, attempt, max_attempts, policy }) => ({
        error_type,
        attempt,
        max_attempts,
        policy,
      })),
      [
        {
          error_type: "agent_failure",
          attempt: 1,
          max_attempts: 4,
          policy: "retry",
        },
        {
          error_type: "halt",
          attempt: 1,
          max_attempts: 4,
          policy: "halt",
        },
      ],
    );
  });
});

// ─── ProviderError retryable retries ─────────────────────────────────────────

test("dispatchWithFailurePolicy: retryable ProviderError retries until exhausted", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    dispatchImpl = async () => {
      calls++;
      throw new ProviderError({
        provider: "anthropic",
        message: "timeout",
        retryable: true,
      });
    };

    try {
      await dispatchWithFailurePolicy({
        ...makeBaseOptions(dir),
        policy: { policy: "retry", maxRetries: 2 },
        levelId: "l1",
        stageType: "pipeline",
        sessionId: "s1",
        errorLogPath: dir,
      });
      assert.fail("expected HaltError");
    } catch (err) {
      assert.ok(err instanceof HaltError);
    }

    assert.equal(calls, 3, "should attempt initial + 2 retries");
    const events = fs
      .readFileSync(path.join(dir, "agent-errors.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.at(-1) && {
        error_type: events.at(-1).error_type,
        attempt: events.at(-1).attempt,
        max_attempts: events.at(-1).max_attempts,
      },
      { error_type: "halt", attempt: 3, max_attempts: 3 },
    );
  });
});

test("dispatchWithFailurePolicy: a shared deadline prevents retries from extending total runtime", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    let observedTimeoutMinutes = Number.POSITIVE_INFINITY;
    dispatchImpl = async (options) => {
      calls += 1;
      observedTimeoutMinutes = options.timeoutMinutes ?? Number.POSITIVE_INFINITY;
      await new Promise((resolve) => setTimeout(resolve, 35));
      throw new ProviderError({
        provider: "anthropic",
        message: "timeout",
        retryable: true,
      });
    };

    await assert.rejects(
      dispatchWithFailurePolicy({
        ...makeBaseOptions(dir),
        policy: { policy: "retry", maxRetries: 2 },
        levelId: "l1",
        stageType: "pipeline",
        sessionId: "s1",
        errorLogPath: dir,
        timeoutMinutes: 10,
        retryDeadlineMs: Date.now() + 20,
      }),
      (error: unknown) =>
        error instanceof HaltError &&
        /deadline expired/i.test(error.message),
    );

    assert.equal(calls, 1);
    assert.ok(observedTimeoutMinutes < 0.01);
  });
});

test("dispatchWithFailurePolicy: invalid result retries without poisoning provider health", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    const messages: string[] = [];
    circuitFailureCount = 0;
    circuitCheckImpl = () => ({ allowed: true });
    dispatchImpl = async (options) => {
      messages.push(options.userMessage);
      return {
        text: ++calls === 1 ? "raw malformed provider payload" : '{"ok":true}',
        cost: 0,
      };
    };

    const result = await dispatchWithFailurePolicy({
      ...makeBaseOptions(dir),
      policy: { policy: "retry", maxRetries: 1 },
      levelId: "l1",
      stageType: "pipeline",
      sessionId: "s1",
      errorLogPath: dir,
      validateResult(text) {
        if (text !== '{"ok":true}') {
          throw new DispatchResultValidationError(
            "Worker returned an invalid structured response.",
            "response_schema_invalid",
            'Correct field "requirementCoverage.asOf": use YYYY-MM-DD or a canonical UTC timestamp.',
          );
        }
        return text;
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.text, '{"ok":true}');
    assert.equal(messages[0], 'hello');
    assert.match(messages[1] ?? '', /# Runtime Validation Feedback/);
    assert.match(messages[1] ?? '', /Correct field "requirementCoverage\.asOf"/);
    assert.doesNotMatch(messages[1] ?? '', /raw malformed provider payload/);
    assert.equal(circuitFailureCount, 0);
    const errorLog = fs.readFileSync(path.join(dir, "agent-errors.jsonl"), "utf8");
    assert.match(errorLog, /Worker returned an invalid structured response/);
    assert.doesNotMatch(errorLog, /raw malformed provider payload/);
  });
});

test("dispatchWithFailurePolicy: fallback output must pass result validation", async () => {
  await withTempDir(async (dir) => {
    circuitCheckImpl = () => ({ allowed: false, reason: "primary circuit open" });
    dispatchImpl = async () => ({ text: "invalid fallback payload", cost: 0 });

    await assert.rejects(
      dispatchWithFailurePolicy({
        ...makeBaseOptions(dir),
        agent: makeAgent("primary"),
        policy: {
          policy: "fallback",
          maxRetries: 0,
          fallbackAgent: "backup",
        },
        fallbackAgent: makeAgent("backup"),
        levelId: "l1",
        stageType: "pipeline",
        sessionId: "s1",
        errorLogPath: dir,
        validateResult() {
          throw new DispatchResultValidationError(
            "Fallback returned an invalid structured response.",
            "response_schema_invalid",
          );
        },
      }),
      (error: unknown) =>
        error instanceof HaltError &&
        /Fallback returned an invalid structured response/.test(error.originalError),
    );
  });
  circuitCheckImpl = () => ({ allowed: true });
});

// ─── Fallback agent after retries ────────────────────────────────────────────

test("dispatchWithFailurePolicy: fallback agent succeeds after retries exhaust", async () => {
  await withTempDir(async (dir) => {
    let primaryCalls = 0;
    dispatchImpl = async (options: DispatchOptions) => {
      if (options.agent.name === "primary") {
        primaryCalls++;
        throw new ProviderError({
          provider: "anthropic",
          message: "fail",
          retryable: true,
        });
      }
      return { text: "fallback result", cost: 0.5 };
    };

    const result = await dispatchWithFailurePolicy({
      ...makeBaseOptions(dir),
      agent: makeAgent("primary"),
      policy: { policy: "retry", maxRetries: 1, fallbackAgent: "backup" },
      fallbackAgent: makeAgent("backup"),
      levelId: "l1",
      stageType: "pipeline",
      sessionId: "s1",
      errorLogPath: dir,
    });

    assert.equal(result.text, "fallback result");
    assert.equal(primaryCalls, 2);
  });
});

test("dispatchWithFailurePolicy: an open primary circuit dispatches the configured fallback", async () => {
  await withTempDir(async (dir) => {
    const attemptedAgents: string[] = [];
    circuitCheckImpl = (provider) => provider === "anthropic"
      ? { allowed: false, reason: "primary provider circuit open" }
      : { allowed: true };
    dispatchImpl = async (options: DispatchOptions) => {
      attemptedAgents.push(options.agent.name);
      return { text: "fallback result", cost: 0.5 };
    };

    try {
      const result = await dispatchWithFailurePolicy({
        ...makeBaseOptions(dir),
        agent: makeAgent("primary", "anthropic"),
        policy: { policy: "fallback", maxRetries: 0, fallbackAgent: "backup" },
        fallbackAgent: makeAgent("backup", "openai"),
        levelId: "l1",
        stageType: "pipeline",
        sessionId: "s1",
        errorLogPath: dir,
      });

      assert.equal(result.text, "fallback result");
      assert.deepEqual(attemptedAgents, ["backup"]);
    } finally {
      circuitCheckImpl = () => ({ allowed: true });
    }
  });
});

// ─── Skip policy with non-retryable error ────────────────────────────────────

test("dispatchWithFailurePolicy: skip policy returns skipped marker", async () => {
  await withTempDir(async (dir) => {
    dispatchImpl = async () => {
      throw new ProviderError({
        provider: "anthropic",
        message: "not found",
        statusCode: 404,
        retryable: false,
      });
    };

    const result = await dispatchWithFailurePolicy({
      ...makeBaseOptions(dir),
      policy: { policy: "skip", maxRetries: 0 },
      levelId: "l1",
      stageType: "discussion",
      sessionId: "s1",
      errorLogPath: dir,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.text, "");
  });
});

test("dispatchWithFailurePolicy: halt budget returns the paid result when a dispatch crosses the limit", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    dispatchImpl = async (options) => {
      calls++;
      options.state.totalCost += 2;
      return { text: "completed response", cost: 2 };
    };
    const options = makeBaseOptions(dir);
    options.state.totalCost = 9;
    const ledger = new BudgetLedger({ capUsd: 10, policy: "halt" });

    const request = () =>
      dispatchWithFailurePolicy({
        ...options,
        policy: { policy: "retry", maxRetries: 3 },
        budgetLedger: ledger,
        totalCost: options.state.totalCost,
        levelId: "l1",
        stageType: "pipeline",
        sessionId: "s1",
        errorLogPath: dir,
      });

    const result = await request();
    assert.match(result.text, /completed response/);
    assert.match(result.text, /Budget limit reached after dispatch/);
    assert.equal(calls, 1, "a budget halt must not retry the paid dispatch");

    // The paid dispatch is returned; the NEXT dispatch halts pre-dispatch.
    await assert.rejects(request(), (error: unknown) => {
      assert.ok(error instanceof HaltError);
      return true;
    });
    assert.equal(calls, 1, "post-limit dispatches must halt before spending");
  });
});

test("dispatchWithFailurePolicy: warn budget reports the dispatch that crosses the limit", async () => {
  await withTempDir(async (dir) => {
    dispatchImpl = async (options) => {
      options.state.totalCost += 2;
      return { text: "completed response", cost: 2 };
    };
    const options = makeBaseOptions(dir);
    options.state.totalCost = 9;
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await dispatchWithFailurePolicy({
        ...options,
        policy: { policy: "skip", maxRetries: 0 },
        budgetLedger: new BudgetLedger({ capUsd: 10, policy: "warn" }),
        totalCost: options.state.totalCost,
        levelId: "l1",
        stageType: "discussion",
        sessionId: "s1",
        errorLogPath: dir,
      });
      assert.match(result.text, /latest dispatch reached or crossed/);
      assert.match(result.text, /\$11\.00 of \$10\.00/);
    } finally {
      console.error = originalError;
    }
  });
});

test("dispatchWithFailurePolicy: queued halt-budget callers re-read spend after acquiring the slot", async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    dispatchImpl = async (options) => {
      calls++;
      await Promise.resolve();
      options.state.totalCost += 1;
      return { text: "paid response", cost: 1 };
    };
    const options = makeBaseOptions(dir);
    const ledger = new BudgetLedger({ capUsd: 1, policy: "halt" });
    const request = () =>
      dispatchWithFailurePolicy({
        ...options,
        policy: { policy: "retry", maxRetries: 2 },
        budgetLedger: ledger,
        totalCost: 0,
        levelId: "l1",
        stageType: "broadcast",
        sessionId: "s1",
        errorLogPath: dir,
      });

    const results = await Promise.allSettled([request(), request()]);
    assert.equal(calls, 1, "the queued caller must not use its stale zero-cost snapshot");
    assert.equal(options.state.totalCost, 1);
    // The dispatch that crossed the limit returns its paid result; the queued
    // caller re-reads the spend and halts before dispatching.
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
      "the paid dispatch returns its result",
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
      "the queued caller halts before spending",
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        assert.match(result.value.text, /Budget limit reached after dispatch/);
      } else {
        assert.ok(result.reason instanceof HaltError);
      }
    }
  });
});

test("dispatchWithFailurePolicy: skip policy under an aborted signal rejects as an abort, not a skip", async () => {
  await withTempDir(async (dir) => {
    dispatchImpl = async () => {
      throw new Error("provider unreachable");
    };
    const options = makeBaseOptions(dir);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      dispatchWithFailurePolicy({
        ...options,
        policy: { policy: "skip", maxRetries: 0 },
        signal: controller.signal,
        levelId: "l1",
        stageType: "broadcast",
        sessionId: "s1",
        errorLogPath: dir,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /abort/i);
        return true;
      },
    );
  });
});

// ─── Output schema survives the retry ────────────────────────────────────────

test("dispatchWithFailurePolicy forwards the output schema on every attempt", async () => {
  await withTempDir(async (dir) => {
    const outputSchema = {
      type: "object",
      properties: { decision: { type: "string" } },
      required: ["decision"],
      additionalProperties: false,
    } as const;
    const observed: Array<Readonly<Record<string, unknown>> | undefined> = [];
    let attempt = 0;
    dispatchImpl = async (options) => {
      observed.push(options.outputSchema);
      attempt += 1;
      // The first answer fails validation, so the retry is the attempt that
      // matters: a destructuring change that drops the schema shows up here.
      return { text: attempt === 1 ? "not json" : '{"decision":"APPROVE"}', cost: 0 };
    };

    const result = await dispatchWithFailurePolicy({
      ...makeBaseOptions(dir),
      outputSchema,
      policy: { policy: "retry", maxRetries: 1 },
      levelId: "quality-audit",
      stageType: "chain",
      sessionId: "s1",
      errorLogPath: dir,
      validateResult: (text: string) => {
        if (!text.startsWith("{")) {
          throw new DispatchResultValidationError(
            "Response must be JSON.",
            "deep_research_quality_verdict",
            "Return one JSON object.",
          );
        }
        return text;
      },
    });

    assert.equal(result.text, '{"decision":"APPROVE"}');
    assert.equal(observed.length, 2);
    assert.deepEqual(observed, [outputSchema, outputSchema]);
  });
});
