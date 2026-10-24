import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  resolveManagedDevRepoRoot,
  shouldOpenManagedUi,
  shouldStartManagedApi,
  shouldStartManagedDevServices,
  shouldStartManagedUi,
} from '../../team-runtime/dev-services.js'

test('managed dev services resolve the repository root after the module move', () => {
  const expectedRoot = path.resolve(process.cwd())
  const movedModuleUrl = pathToFileURL(
    path.join(expectedRoot, 'team-runtime', 'dev-services.ts'),
  ).href

  assert.equal(resolveManagedDevRepoRoot(movedModuleUrl), expectedRoot)
  assert.equal(fs.existsSync(path.join(expectedRoot, 'ui', 'package.json')), true)
})

test('managed dev services start by default for a root extension process', () => {
  const env = {}

  assert.equal(shouldStartManagedDevServices(env), true)
  assert.equal(shouldStartManagedApi(env), true)
  assert.equal(shouldStartManagedUi(env), true)
  assert.equal(shouldOpenManagedUi(env), true)
})

test('managed dev services stay disabled for delegated and API-launched child processes', () => {
  assert.equal(shouldStartManagedDevServices({ TEAM_DELEGATED_AUTOSTART: '1' }), false)
  assert.equal(shouldStartManagedDevServices({ TEAM_PARENT_SESSION_ID: 'parent-run' }), false)
  assert.equal(shouldStartManagedDevServices({ TEAM_RUNTIME_START_SERVICES: '0' }), false)
  assert.equal(shouldOpenManagedUi({ TEAM_RUNTIME_START_SERVICES: '0' }), false)
})

test('managed API and UI can be disabled independently', () => {
  assert.equal(shouldStartManagedApi({ TEAM_RUNTIME_START_API: '0' }), false)
  assert.equal(shouldStartManagedUi({ TEAM_RUNTIME_START_UI: 'false' }), false)
  assert.equal(shouldStartManagedApi({ TEAM_RUNTIME_START_UI: '0' }), true)
  assert.equal(shouldStartManagedUi({ TEAM_RUNTIME_START_API: '0' }), true)
  assert.equal(shouldOpenManagedUi({ TEAM_RUNTIME_OPEN_UI: '0' }), false)
})
