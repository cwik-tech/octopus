/**
 * The one application-wide default effort, and who inherits it.
 *
 * An Agent that names no level has always run at `medium`, decided by a
 * constant compiled into four different readers. Making that a setting means
 * the readers have to ask at the moment they read, rather than baking in
 * whatever the value was when their module loaded — and a spawned runtime has
 * to receive the same answer, or a turn would inherit one default in the API
 * process and another in the child that runs it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_EFFORT_ENV,
  getRuntimeDefaultEffort,
  setRuntimeDefaultEffort,
} from '../../domains/provider/default-effort-selection.js'
import { DEFAULT_THINKING } from '../../core/constants.js'

function withEnvironment(value: string | undefined, run: () => void): void {
  const original = process.env[DEFAULT_EFFORT_ENV]
  if (value === undefined) delete process.env[DEFAULT_EFFORT_ENV]
  else process.env[DEFAULT_EFFORT_ENV] = value
  setRuntimeDefaultEffort(undefined)
  try {
    run()
  } finally {
    if (original === undefined) delete process.env[DEFAULT_EFFORT_ENV]
    else process.env[DEFAULT_EFFORT_ENV] = original
    setRuntimeDefaultEffort(undefined)
  }
}

test('an installation that has never chosen one still runs at medium', () => {
  withEnvironment(undefined, () => {
    assert.equal(getRuntimeDefaultEffort(), DEFAULT_THINKING)
    assert.equal(getRuntimeDefaultEffort(), 'medium')
  })
})

test('the chosen default is what an unset Agent inherits', () => {
  withEnvironment(undefined, () => {
    setRuntimeDefaultEffort('xhigh')
    assert.equal(getRuntimeDefaultEffort(), 'xhigh')
  })
})

test('a spawned runtime inherits the same answer through the environment', () => {
  // A child process never calls the setter. It reads what the parent put in the
  // environment, and the two must agree or one turn is budgeted twice.
  withEnvironment('max', () => {
    assert.equal(getRuntimeDefaultEffort(), 'max')
  })
})

test('the provider default is a legitimate application-wide choice', () => {
  // "Let each provider decide" is a real answer to this question, and it is not
  // the same as `medium`.
  withEnvironment(undefined, () => {
    setRuntimeDefaultEffort('provider-default')
    assert.equal(getRuntimeDefaultEffort(), 'provider-default')
  })
})

test('a value this application cannot express is ignored rather than obeyed', () => {
  withEnvironment('galactic', () => {
    assert.equal(getRuntimeDefaultEffort(), DEFAULT_THINKING)
  })
})

test('each new choice replaces what children are told', () => {
  withEnvironment('high', () => {
    setRuntimeDefaultEffort(undefined)
    setRuntimeDefaultEffort('low')
    assert.equal(process.env[DEFAULT_EFFORT_ENV], 'low')
    setRuntimeDefaultEffort(DEFAULT_THINKING)
    assert.equal(process.env[DEFAULT_EFFORT_ENV], 'medium')
  })
})
