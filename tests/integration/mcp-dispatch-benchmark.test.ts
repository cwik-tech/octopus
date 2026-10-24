import assert from 'node:assert/strict'
import * as path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runMcpBrokerEchoBenchmark } from '../../scripts/benchmark-capability-dispatch.js'

test('MCP dispatch benchmark measures real stdio echo, MCP audit, and common dispatch writes', { timeout: 20_000 }, async () => {
  const compiledRoot = path.join(process.cwd(), '.tests-dist')
  const moduleRoot = fileURLToPath(import.meta.url).startsWith(
    `${compiledRoot}${path.sep}`,
  )
    ? compiledRoot
    : process.cwd()
  const report = await runMcpBrokerEchoBenchmark({
    moduleRoot,
    iterations: 3,
    warmupIterations: 1,
  })

  assert.equal(report.iterations, 3)
  assert.equal(report.warmupIterations, 1)
  assert.equal(report.echoValidated, true)
  assert.equal(report.auditEventsPerMeasuredCall, 3)
  assert.equal(report.dispatchEventsPerMeasuredCall, 3)
  assert.equal(report.brokerEchoMs.samples, 3)
  assert.equal(Number.isFinite(report.brokerEchoMs.p95Ms), true)
  assert.equal(report.auditBytesPerMeasuredCall > 0, true)
  assert.equal(report.dispatchBytesPerMeasuredCall > 0, true)
})
