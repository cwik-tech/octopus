import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseWebEvidenceRolloutConfig,
  resolveWebEvidenceClaimsMode,
  resolveWebEvidenceLinksMode,
  webEvidenceRolloutRequiresRecorder,
  WebEvidenceRolloutConfigurationError,
} from '../../domains/browser/web-evidence-rollout.js'

test('unset settings default both capabilities to off', () => {
  assert.deepEqual(parseWebEvidenceRolloutConfig({}), {
    links: { mode: 'off', percent: 100 },
    claims: { mode: 'off', percent: 100, cohorts: [] },
  })
  assert.deepEqual(
    parseWebEvidenceRolloutConfig({
      links: '',
      linksPercent: '',
      claims: '',
      claimsPercent: '',
      claimCohorts: '',
    }),
    {
      links: { mode: 'off', percent: 100 },
      claims: { mode: 'off', percent: 100, cohorts: [] },
    },
  )
})

test('an unknown links mode fails, naming the variable and the value', () => {
  assert.throws(
    () => parseWebEvidenceRolloutConfig({ links: 'enforce-everything' }),
    (error: unknown) => {
      assert.ok(error instanceof WebEvidenceRolloutConfigurationError)
      assert.match(error.message, /PIPELINE_WEB_EVIDENCE_LINKS/)
      assert.match(error.message, /enforce-everything/)
      return true
    },
  )
})

test('an unknown claims mode fails, naming the variable and the value', () => {
  assert.throws(
    () => parseWebEvidenceRolloutConfig({ claims: 'preview' }),
    (error: unknown) => {
      assert.ok(error instanceof WebEvidenceRolloutConfigurationError)
      assert.match(error.message, /PIPELINE_WEB_EVIDENCE_CLAIMS/)
      assert.match(error.message, /preview/)
      return true
    },
  )
})

test('percentages are integers from 0 through 100', () => {
  for (const [value, expected] of [['0', 0], ['7', 7], ['100', 100]] as const) {
    assert.equal(
      parseWebEvidenceRolloutConfig({ linksPercent: value }).links.percent,
      expected,
    )
  }
  for (const value of ['101', '-1', '1.5', 'abc', '10 ', ' 10', '0x10']) {
    assert.throws(
      () => parseWebEvidenceRolloutConfig({ linksPercent: value }),
      (error: unknown) => {
        assert.ok(error instanceof WebEvidenceRolloutConfigurationError)
        assert.match(error.message, /PIPELINE_WEB_EVIDENCE_LINKS_PERCENT/)
        return true
      },
      `percentage '${value}' must be rejected`,
    )
  }
})

test('claim cohorts are a versioned strictly parsed JSON array', () => {
  assert.throws(
    () => parseWebEvidenceRolloutConfig({ claimCohorts: 'openai:mcp-native' }),
    /PIPELINE_WEB_EVIDENCE_CLAIM_COHORTS/,
    'a delimiter-dependent string is not accepted',
  )
  assert.throws(
    () => parseWebEvidenceRolloutConfig({ claimCohorts: '{"provider":"openai"}' }),
    /PIPELINE_WEB_EVIDENCE_CLAIM_COHORTS/,
    'a non-array document is not accepted',
  )
  assert.throws(
    () =>
      parseWebEvidenceRolloutConfig({
        claimCohorts: JSON.stringify([{ provider: 'openai', route: 'mcp-native' }]),
      }),
    /schemaVersion/,
    'an unversioned entry is not accepted',
  )
  assert.throws(
    () =>
      parseWebEvidenceRolloutConfig({
        claimCohorts: JSON.stringify([{
          schemaVersion: 1,
          provider: 'openai',
          route: 'mcp-native',
          model: 'gpt-test',
        }]),
      }),
    /model/,
    'an entry with an unexpected key is not accepted',
  )
  assert.throws(
    () =>
      parseWebEvidenceRolloutConfig({
        claimCohorts: JSON.stringify([{
          schemaVersion: 1,
          provider: 'openai',
          route: 'direct-provider',
        }]),
      }),
    /route/,
    'a route outside the closed union is not accepted',
  )

  const config = parseWebEvidenceRolloutConfig({
    claims: 'shadow',
    claimCohorts: JSON.stringify([
      { schemaVersion: 1, provider: 'openai', route: 'mcp-native' },
      { schemaVersion: 1, provider: 'codex', route: 'mcp-cli' },
    ]),
  })
  assert.deepEqual(config.claims.cohorts, [
    { schemaVersion: 1, provider: 'openai', route: 'mcp-native' },
    { schemaVersion: 1, provider: 'codex', route: 'mcp-cli' },
  ])
})

test('capability B enforce is invalid unless capability A enforces', () => {
  assert.throws(
    () => parseWebEvidenceRolloutConfig({ links: 'shadow', claims: 'enforce' }),
    /PIPELINE_WEB_EVIDENCE_CLAIMS/,
  )
  assert.throws(
    () => parseWebEvidenceRolloutConfig({ claims: 'enforce' }),
    /PIPELINE_WEB_EVIDENCE_CLAIMS/,
    'links defaults to off, which also cannot back claims enforcement',
  )
  const config = parseWebEvidenceRolloutConfig({
    links: 'enforce',
    claims: 'enforce',
  })
  assert.equal(config.links.mode, 'enforce')
  assert.equal(config.claims.mode, 'enforce')
})

test('assignment sampling is deterministic and bounded by the percentage', () => {
  const config = parseWebEvidenceRolloutConfig({
    links: 'shadow',
    linksPercent: '50',
  })
  const sampled = new Map<string, string>()
  let inSample = 0
  for (let index = 0; index < 400; index += 1) {
    const assignmentId = `assignment-${index}`
    const mode = resolveWebEvidenceLinksMode(config, assignmentId)
    assert.equal(mode, resolveWebEvidenceLinksMode(config, assignmentId),
      'the same assignment must always resolve the same way')
    sampled.set(assignmentId, mode)
    if (mode === 'shadow') inSample += 1
  }
  assert.ok(inSample > 0, 'a 50% sample cannot be empty over 400 assignments')
  assert.ok(inSample < 400, 'a 50% sample cannot cover every assignment')

  // Monotonicity: an assignment inside the sample at one percentage stays
  // inside at every higher percentage, so widening a canary never reshuffles.
  const wider = parseWebEvidenceRolloutConfig({
    links: 'shadow',
    linksPercent: '75',
  })
  for (const [assignmentId, mode] of sampled) {
    if (mode !== 'shadow') continue
    assert.equal(resolveWebEvidenceLinksMode(wider, assignmentId), 'shadow')
  }

  assert.equal(
    resolveWebEvidenceLinksMode(
      parseWebEvidenceRolloutConfig({ links: 'enforce', linksPercent: '0' }),
      'assignment-1',
    ),
    'off',
    'a zero percent sample turns the mode off for every assignment',
  )
  assert.equal(
    resolveWebEvidenceLinksMode(
      parseWebEvidenceRolloutConfig({ links: 'enforce' }),
      'assignment-1',
    ),
    'enforce',
    'an unset percentage applies the mode to every assignment',
  )
  assert.equal(
    resolveWebEvidenceLinksMode(
      parseWebEvidenceRolloutConfig({}),
      'assignment-1',
    ),
    'off',
  )
})

test('claim cohort selection honours the allowlist and the links prerequisite', () => {
  const config = parseWebEvidenceRolloutConfig({
    links: 'enforce',
    claims: 'enforce',
    claimCohorts: JSON.stringify([
      { schemaVersion: 1, provider: 'openai', route: 'mcp-native' },
    ]),
  })
  assert.equal(
    resolveWebEvidenceClaimsMode(config, {
      assignmentId: 'assignment-1',
      provider: 'codex',
      route: 'mcp-cli',
    }),
    'off',
    'a provider route outside the allowlist is never a claims cohort',
  )
  assert.equal(
    resolveWebEvidenceClaimsMode(config, {
      assignmentId: 'assignment-1',
      provider: 'openai',
      route: 'mcp-native',
    }),
    'enforce',
  )

  // Capability B cannot outrun Capability A on the same assignment: when the
  // links sample leaves this assignment out, claims enforce resolves off too.
  const sampled = parseWebEvidenceRolloutConfig({
    links: 'enforce',
    linksPercent: '50',
    claims: 'enforce',
    claimCohorts: JSON.stringify([
      { schemaVersion: 1, provider: 'openai', route: 'mcp-native' },
    ]),
  })
  for (let index = 0; index < 400; index += 1) {
    const assignmentId = `assignment-${index}`
    const claimsMode = resolveWebEvidenceClaimsMode(sampled, {
      assignmentId,
      provider: 'openai',
      route: 'mcp-native',
    })
    if (resolveWebEvidenceLinksMode(sampled, assignmentId) !== 'enforce') {
      assert.equal(claimsMode, 'off')
    }
  }

  const shadow = parseWebEvidenceRolloutConfig({
    claims: 'shadow',
    claimCohorts: JSON.stringify([
      { schemaVersion: 1, provider: 'openai', route: 'mcp-native' },
    ]),
  })
  assert.equal(
    resolveWebEvidenceClaimsMode(shadow, {
      assignmentId: 'assignment-1',
      provider: 'openai',
      route: 'mcp-native',
    }),
    'shadow',
    'capability B shadow does not require capability A enforcement',
  )
})

test('shadow and enforce require a recorder; off does not', () => {
  assert.equal(webEvidenceRolloutRequiresRecorder(parseWebEvidenceRolloutConfig({})), false)
  assert.equal(
    webEvidenceRolloutRequiresRecorder(
      parseWebEvidenceRolloutConfig({ links: 'shadow' }),
    ),
    true,
  )
  assert.equal(
    webEvidenceRolloutRequiresRecorder(
      parseWebEvidenceRolloutConfig({ links: 'enforce' }),
    ),
    true,
  )
  assert.equal(
    webEvidenceRolloutRequiresRecorder(
      parseWebEvidenceRolloutConfig({ claims: 'shadow' }),
    ),
    true,
  )
})
