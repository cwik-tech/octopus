import { performance } from 'node:perf_hooks'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  hostAuditedParallelReadEffect,
  serialCapabilityEffect,
} from '../contracts/capability-effect.js'
import {
  MAX_CONCURRENT_TOOL_CALLS_CEILING,
  runProviderToolLoop,
  type ProviderToolDefinition,
} from '../domains/provider/provider-tool-loop.js'

const CALLS_PER_TURN = Number(process.env.FANOUT_CALLS_PER_TURN ?? 8)
const EXECUTOR_LATENCY_MS = Number(process.env.FANOUT_EXECUTOR_LATENCY_MS ?? 10)
const SAMPLES = Number(process.env.FANOUT_SAMPLES ?? 30)
const WARMUP_SAMPLES = 5
const POOLS = [1, 2, 4, MAX_CONCURRENT_TOOL_CALLS_CEILING]

interface PoolReport {
  readonly pool: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly overlapCount: number
}

interface FanoutBenchmarkReport {
  readonly callsPerTurn: number
  readonly executorLatencyMs: number
  readonly samples: number
  readonly warmupSamples: number
  readonly pools: readonly PoolReport[]
}

async function main(): Promise<void> {
  const report = await runFanoutBenchmark()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

async function runFanoutBenchmark(): Promise<FanoutBenchmarkReport> {
  const tool: ProviderToolDefinition = {
    name: 'benchmark_read',
    description: 'Benchmark eligible read fan-out.',
    effect: hostAuditedParallelReadEffect(),
    inputSchema: {
      type: 'object',
      properties: { marker: { type: 'string' } },
      required: ['marker'],
      additionalProperties: false,
    },
  }
  const serialTool: ProviderToolDefinition = {
    ...tool,
    name: 'benchmark_serial_read',
    effect: serialCapabilityEffect('read-only'),
  }
  const pools: PoolReport[] = []
  for (const pool of POOLS) {
    const { timings, overlapCount } = await measurePool(
      tool,
      CALLS_PER_TURN,
      pool,
    )
    pools.push({
      pool,
      p50Ms: percentile(timings, 0.5),
      p95Ms: percentile(timings, 0.95),
      overlapCount,
    })
  }
  const serial = await measurePool(serialTool, CALLS_PER_TURN, 1)
  pools.unshift({
    pool: 1,
    p50Ms: percentile(serial.timings, 0.5),
    p95Ms: percentile(serial.timings, 0.95),
    overlapCount: serial.overlapCount,
  })
  return {
    callsPerTurn: CALLS_PER_TURN,
    executorLatencyMs: EXECUTOR_LATENCY_MS,
    samples: SAMPLES,
    warmupSamples: WARMUP_SAMPLES,
    pools,
  }
}

async function measurePool(
  tool: ProviderToolDefinition,
  callsPerTurn: number,
  pool: number,
): Promise<{ timings: number[]; overlapCount: number }> {
  const timings: number[] = []
  let overlapCount = 0
  for (let sample = -WARMUP_SAMPLES; sample < SAMPLES; sample += 1) {
    const events: string[] = []
    const started = performance.now()
    await runProviderToolLoop({
      messages: [
        { role: 'system', content: 'Fan out reads.' },
        { role: 'user', content: 'Read every marker.' },
      ],
      tools: [tool],
      maxConcurrentToolCalls: pool,
      adapter: {
        complete: async (request) => {
          if (request.messages.some((message) => message.role === 'tool')) {
            return { content: 'done', toolCalls: [] }
          }
          return {
            content: null,
            toolCalls: Array.from({ length: callsPerTurn }, (_, index) => ({
              id: `call-${index + 1}`,
              name: tool.name,
              arguments: { marker: `marker-${index + 1}` },
            })),
          }
        },
      },
      executeTool: async (call) => {
        events.push(`start:${call.id}`)
        await delay(EXECUTOR_LATENCY_MS)
        events.push(`settle:${call.id}`)
        return { content: `done:${call.id}` }
      },
    })
    if (sample >= 0) timings.push(performance.now() - started)
    const firstSettle = events.indexOf('settle:call-1')
    const anyOtherStart = events.findIndex(
      (event, index) => index > 0 && event.startsWith('start:'),
    )
    if (anyOtherStart !== -1 && anyOtherStart < firstSettle) overlapCount += 1
  }
  return { timings, overlapCount }
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.floor(fraction * sorted.length),
  )
  return Math.round((sorted[index] ?? 0) * 100) / 100
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return Boolean(entry && pathToFileURL(path.resolve(entry)).href === moduleUrl)
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error'
    process.stderr.write(`Provider tool fan-out benchmark failed: ${message}\n`)
    process.exitCode = 1
  })
}
