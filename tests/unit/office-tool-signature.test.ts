import assert from 'node:assert/strict'
import test from 'node:test'
import { officeToolSignatureIssue } from '../../core/office-tool-signature.js'

const app = { team: 'APPTEAM', runtime: true }
test('a packaged native tool must share the app signing team and hardened runtime', () => {
  assert.equal(officeToolSignatureIssue(app, { team: 'OTHERTEAM', runtime: true }), 'signing_team_mismatch')
  assert.equal(officeToolSignatureIssue(app, { team: 'APPTEAM', runtime: false }), 'hardened_runtime_missing')
  assert.equal(officeToolSignatureIssue(app, { team: null, runtime: true }), 'signing_team_mismatch')
  assert.equal(officeToolSignatureIssue(app, { team: 'APPTEAM', runtime: true }), undefined)
})
test('an ad hoc app preserves the staged native signature without inventing a signing team', () => {
  assert.equal(officeToolSignatureIssue({ team: null, runtime: false }, { team: null, runtime: false }), undefined)
})
