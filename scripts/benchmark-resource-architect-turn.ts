import { whenDefined } from '../core/optional-properties.js'
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

type BenchmarkMode = "baseline" | "current";
type BenchmarkOperation = "conversation" | "proposal";

export interface ResourceArchitectBenchmarkFixture {
  id: string;
  operation: BenchmarkOperation;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  document?: { name: string; contentType: string; content: string };
}

export interface ResourceArchitectBenchmarkSample {
  fixture: string;
  repetition: number;
  status: number;
  httpDurationMs: number;
  processSpawnMs?: number | null;
  firstProviderEventMs?: number | null;
  firstTextMs?: number | null;
  providerDurationMs?: number;
  totalDurationMs?: number;
  contextChars?: number;
  repairOccurred?: boolean;
  fallback?: boolean;
  error?: string;
}

interface BenchmarkInput {
  mode: BenchmarkMode;
  sourceRevision: string;
  repetitions: number;
  samples: ResourceArchitectBenchmarkSample[];
}

interface BenchmarkArguments {
  mode: BenchmarkMode;
  repetitions: number;
  sourceRoot: string;
  sourceRevision: string;
  fixtureList?: string;
  provider?: string;
  model?: string;
  outputPath?: string;
}

export function createResourceArchitectBenchmarkFixtures(): ResourceArchitectBenchmarkFixture[] {
  return [
    {
      id: "greeting",
      operation: "conversation",
      history: [{ role: "user", text: "Hello. What can you help me design?" }],
    },
    {
      id: "clarification",
      operation: "conversation",
      history: [
        { role: "user", text: "I need a Team to review commercial contracts." },
        { role: "assistant", text: "Which jurisdiction and contract types matter most?" },
        { role: "user", text: "Michigan law, mainly SaaS and vendor agreements." },
      ],
    },
    {
      id: "exact-id",
      operation: "conversation",
      history: [{
        role: "user",
        text: "Explain the existing Agent with exact ID resource-architect. Do not create anything.",
      }],
    },
    {
      id: "proposal",
      operation: "proposal",
      history: [{
        role: "user",
        text: "Prepare a proposal for one standalone Agent that reviews Michigan SaaS contracts. Do not build it yet.",
      }],
    },
    {
      id: "document-grounded",
      operation: "conversation",
      history: [{
        role: "user",
        text: "Using the uploaded Phoenix brief, explain what expertise the Team should cover and ask one useful clarification. Do not create it.",
      }],
      document: {
        name: "phoenix-brief.txt",
        contentType: "text/plain",
        content: [
          "Project Phoenix reviews Michigan SaaS and vendor agreements.",
          "Priorities: limitation of liability, data processing, security, and renewal terms.",
          "The Team must distinguish legal risk from commercial negotiation choices.",
        ].join("\n"),
      },
    },
  ];
}

export function selectResourceArchitectBenchmarkFixtures(
  fixtureList?: string,
): ResourceArchitectBenchmarkFixture[] {
  const fixtures = createResourceArchitectBenchmarkFixtures();
  if (!fixtureList) return fixtures;
  const requested = fixtureList.split(",").map((value) => value.trim()).filter(Boolean);
  const selected = requested.map((fixtureId) => {
    const fixture = fixtures.find((candidate) => candidate.id === fixtureId);
    if (!fixture) throw new Error(`Unknown benchmark fixture '${fixtureId}'`);
    return fixture;
  });
  return selected;
}

export function summarizeResourceArchitectBenchmark(input: BenchmarkInput) {
  const fixtureIds = [...new Set(input.samples.map((sample) => sample.fixture))];
  return {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    mode: input.mode,
    sourceRevision: input.sourceRevision,
    repetitions: input.repetitions,
    summary: fixtureIds.map((fixture) => {
      const samples = input.samples.filter((sample) => sample.fixture === fixture);
      const successful = samples.filter((sample) => sample.status >= 200 && sample.status < 300 && !sample.error);
      return {
        fixture,
        samples: samples.length,
        successes: successful.length,
        failures: samples.length - successful.length,
        httpDurationMs: statistics(samples.map((sample) => sample.httpDurationMs)),
        processSpawnMs: statistics(successful.flatMap((sample) => numberValues(sample.processSpawnMs))),
        firstProviderEventMs: statistics(successful.flatMap((sample) => numberValues(sample.firstProviderEventMs))),
        firstTextMs: statistics(successful.flatMap((sample) => numberValues(sample.firstTextMs))),
        providerDurationMs: statistics(successful.flatMap((sample) => numberValues(sample.providerDurationMs))),
        totalDurationMs: statistics(successful.flatMap((sample) => numberValues(sample.totalDurationMs))),
        contextChars: statistics(successful.flatMap((sample) => numberValues(sample.contextChars))),
        repairRate: successful.length
          ? successful.filter((sample) => sample.repairOccurred).length / successful.length
          : null,
        fallbackRate: successful.length
          ? successful.filter((sample) => sample.fallback).length / successful.length
          : null,
      };
    }),
    samples: input.samples,
  };
}

async function runBenchmark(options: BenchmarkArguments): Promise<void> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "resource-architect-benchmark-"));
  const apiModuleUrl = pathToFileURL(path.join(options.sourceRoot, "server", "api-server.ts")).href;
  const { startDefaultApiServer } = await import(apiModuleUrl) as {
    startDefaultApiServer(params: { workspacePath: string; port?: number }): Promise<{
      url: string;
      close(): Promise<void>;
    }>;
  };
  const api = await startDefaultApiServer({ workspacePath, port: 0 });
  const samples: ResourceArchitectBenchmarkSample[] = [];
  try {
    for (const fixture of selectResourceArchitectBenchmarkFixtures(options.fixtureList)) {
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        samples.push(await runFixture({
          apiUrl: api.url,
          fixture,
          repetition,
          mode: options.mode,
          ...whenDefined(options.provider, (provider) => ({ provider: provider })),
          ...whenDefined(options.model, (model) => ({ model: model })),
        }));
      }
    }
  } finally {
    await api.close();
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  const report = summarizeResourceArchitectBenchmark({
    mode: options.mode,
    sourceRevision: options.sourceRevision,
    repetitions: options.repetitions,
    samples,
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) await fs.writeFile(options.outputPath, output, "utf8");
  process.stdout.write(output);
}

async function runFixture(params: {
  apiUrl: string;
  fixture: ResourceArchitectBenchmarkFixture;
  repetition: number;
  mode: BenchmarkMode;
  provider?: string;
  model?: string;
}): Promise<ResourceArchitectBenchmarkSample> {
  const ownerId = `benchmark-${params.fixture.id}-${params.repetition}-${randomUUID()}`;
  if (params.fixture.document) {
    const upload = await fetch(
      `${params.apiUrl}/create/team-files/${encodeURIComponent(ownerId)}/files`,
      {
        method: "POST",
        headers: {
          "content-type": params.fixture.document.contentType,
          "x-filename": encodeURIComponent(params.fixture.document.name),
        },
        body: params.fixture.document.content,
      },
    );
    if (!upload.ok) {
      return {
        fixture: params.fixture.id,
        repetition: params.repetition,
        status: upload.status,
        httpDurationMs: 0,
        error: `document upload failed: ${await upload.text()}`,
      };
    }
  }

  const requestBody = {
    jobId: randomUUID(),
    ...(params.mode === "current" ? { operation: params.fixture.operation } : {}),
    history: params.fixture.history,
    currentPlan: null,
    ...(params.fixture.document ? { draftId: ownerId } : {}),
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.model ? { model: params.model } : {}),
  };
  const startedAt = performance.now();
  try {
    const response = await fetch(`${params.apiUrl}/create/resource-architect/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const httpDurationMs = performance.now() - startedAt;
    const payload = await response.json().catch(() => null) as {
      error?: string;
      meta?: {
        fallback?: boolean;
        timing?: {
          processSpawnMs?: number | null;
          firstProviderEventMs?: number | null;
          firstTextMs?: number | null;
          providerDurationMs?: number;
          totalDurationMs?: number;
          repairOccurred?: boolean;
          context?: { totalChars?: number };
        };
      };
    } | null;
    return {
      fixture: params.fixture.id,
      repetition: params.repetition,
      status: response.status,
      httpDurationMs,
      ...whenDefined(payload?.meta?.timing?.processSpawnMs, (processSpawnMs) => ({ processSpawnMs })),
      ...whenDefined(payload?.meta?.timing?.firstProviderEventMs, (firstProviderEventMs) => ({ firstProviderEventMs })),
      ...whenDefined(payload?.meta?.timing?.firstTextMs, (firstTextMs) => ({ firstTextMs })),
      ...whenDefined(payload?.meta?.timing?.providerDurationMs, (providerDurationMs) => ({ providerDurationMs })),
      ...whenDefined(payload?.meta?.timing?.totalDurationMs, (totalDurationMs) => ({ totalDurationMs })),
      ...whenDefined(payload?.meta?.timing?.context?.totalChars, (contextChars) => ({ contextChars })),
      ...whenDefined(payload?.meta?.timing?.repairOccurred, (repairOccurred) => ({ repairOccurred })),
      ...whenDefined(payload?.meta?.fallback, (fallback) => ({ fallback })),
      ...(!response.ok ? { error: payload?.error ?? `HTTP ${response.status}` } : {}),
    };
  } catch (error) {
    return {
      fixture: params.fixture.id,
      repetition: params.repetition,
      status: 0,
      httpDurationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function statistics(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    minimum: sampleAt(sorted, 0),
    median: median(sorted),
    p95: percentile(sorted, 0.95),
    maximum: sampleAt(sorted, sorted.length - 1),
    mean: sum / sorted.length,
  };
}

function median(sorted: number[]): number {
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sampleAt(sorted, midpoint);
  return (sampleAt(sorted, midpoint - 1) + sampleAt(sorted, midpoint)) / 2;
}

function percentile(sorted: number[], percentileValue: number): number {
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sampleAt(sorted, index);
}

function sampleAt(sorted: number[], index: number): number {
  const value = sorted[index];
  if (value === undefined) {
    throw new Error(`Sample index ${index} is outside ${sorted.length} recorded values`);
  }
  return value;
}

function numberValues(value: number | null | undefined): number[] {
  return typeof value === "number" && Number.isFinite(value) ? [value] : [];
}

function parseArguments(argv = process.argv.slice(2)): BenchmarkArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument near '${key ?? ""}'`);
    values.set(key.slice(2), value);
  }
  const mode = values.get("mode") ?? "current";
  if (mode !== "baseline" && mode !== "current") throw new Error("--mode must be baseline or current");
  const repetitions = Number(values.get("repetitions") ?? 2);
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("--repetitions must be a positive integer");
  const output = values.get("output");
  return {
    mode,
    repetitions,
    sourceRoot: path.resolve(values.get("source-root") ?? process.cwd()),
    sourceRevision: values.get("revision") ?? "working-tree",
    ...whenDefined(values.get("fixture"), (fixtureList) => ({ fixtureList: fixtureList })),
    ...whenDefined(values.get("provider"), (provider) => ({ provider: provider })),
    ...whenDefined(values.get("model"), (model) => ({ model: model })),
    ...whenDefined(output ? path.resolve(output) : undefined, (outputPath) => ({ outputPath: outputPath })),
  };
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  await runBenchmark(parseArguments());
}
