import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { callModel } from '../../domains/provider/model-client.js'
import { initProviders } from '../../providers/index.js'
import { isReviewerUnavailable } from '../../domains/resource-architect/resource-architect-feedback.js'

for (const provider of ['codex', 'claude']) {
test(`${provider} exposes a typed reviewer availability failure when its executable is absent`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-unavailable-'))
  const priorPath = process.env.PATH
  const priorFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  // An empty search directory exercises a real ENOENT without starting a paid
  // provider. Disable the desktop PATH additions; installed CLIs stay untouched.
  process.env.PATH = directory
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'
  initProviders()
  try {
    const result = await callModel('__local_cli__', {
      provider, model: 'synthetic-reviewer', systemPrompt: 'Review the candidate.',
      messages: [{ role: 'user', content: 'Synthetic candidate.' }], signal: AbortSignal.timeout(5_000),
    })
    assert.equal(result.ok, false)
    assert.equal(result.diagnostics.failure?.providerCode, 'executable_unavailable', JSON.stringify(result.diagnostics))
    assert.equal(isReviewerUnavailable(result.diagnostics.failure), true)
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /Synthetic candidate|missing-interpreter/)
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorFallback === undefined) delete process.env.PIPELINE_CLI_PATH_FALLBACK
    else process.env.PIPELINE_CLI_PATH_FALLBACK = priorFallback
    await fs.rm(directory, { recursive: true, force: true })
  }
})
}
