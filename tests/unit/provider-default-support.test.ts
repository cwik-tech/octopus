/**
 * Keeps the pure selection contract in step with the adapters.
 *
 * `PROVIDER_CHOSEN_DEFAULT_PROVIDERS` claims that a specific set of providers
 * can be asked to choose their own model. That claim is only true because
 * those adapters leave the model flag off the command line when the model
 * reads `default`. The contract is pure and cannot look, so this test looks
 * for it: a provider listed without that guard would advertise a selection the
 * request cannot express, and the call would fail at the provider instead.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { PROVIDER_CHOSEN_DEFAULT_PROVIDERS } from '../../contracts/agent-model-selection.js'
import { KNOWN_AGENT_PROVIDER_NAMES } from '../../domains/provider/provider-preflight.js'

const PROVIDERS_DIR = path.join(process.cwd(), 'providers')

/** Adapters that guard on the sentinel but are not offered as a choice. */
const GUARDS_WITHOUT_BEING_OFFERED = new Set(['codex'])

function adapterSource(provider: string): string {
  const file = path.join(PROVIDERS_DIR, `${provider}.ts`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function omitsModelWhenSentinel(source: string): boolean {
  return /!==\s*(['"])default\1/.test(source)
}

test('every provider offered as provider-chosen has an adapter that omits the model', () => {
  for (const provider of PROVIDER_CHOSEN_DEFAULT_PROVIDERS) {
    const source = adapterSource(provider)
    assert.notEqual(source, '', `providers/${provider}.ts must exist`)
    assert.equal(
      omitsModelWhenSentinel(source),
      true,
      `providers/${provider}.ts must skip the model flag when the model is 'default'`,
    )
  }
})

test('no other agent provider silently sends the sentinel as a model id', () => {
  for (const provider of KNOWN_AGENT_PROVIDER_NAMES) {
    if (PROVIDER_CHOSEN_DEFAULT_PROVIDERS.includes(provider)) continue
    if (GUARDS_WITHOUT_BEING_OFFERED.has(provider)) continue
    const source = adapterSource(provider)
    if (!source) continue
    assert.equal(
      omitsModelWhenSentinel(source),
      false,
      `providers/${provider}.ts handles 'default' but is not offered as a provider-chosen selection`,
    )
  }
})
