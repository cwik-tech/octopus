import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  readCodexSubscriptionAccessToken,
  validateCodexSubscriptionAuth,
} from '../../core/codex-subscription-auth.js'

function withCodexHome(
  auth: Record<string, unknown> | null,
  run: (codexHome: string) => void,
): void {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-subscription-auth-'))
  try {
    if (auth) {
      fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(auth))
    }
    run(codexHome)
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
}

test('readCodexSubscriptionAccessToken reads ChatGPT subscription auth without an API key', () => {
  withCodexHome(
    {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'subscription-access-token' },
    },
    (codexHome) => {
      assert.equal(
        readCodexSubscriptionAccessToken({ CODEX_HOME: codexHome }),
        'subscription-access-token',
      )
    },
  )
})

test('validateCodexSubscriptionAuth rejects API-key auth mode', () => {
  withCodexHome(
    {
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'must-not-be-used',
    },
    (codexHome) => {
      assert.match(
        validateCodexSubscriptionAuth({ CODEX_HOME: codexHome }) ?? '',
        /ChatGPT subscription login/i,
      )
    },
  )
})

test('validateCodexSubscriptionAuth reports missing Codex login state', () => {
  withCodexHome(null, (codexHome) => {
    assert.match(
      validateCodexSubscriptionAuth({ CODEX_HOME: codexHome }) ?? '',
      /codex login/i,
    )
  })
})
