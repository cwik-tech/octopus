import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_MAXIMUM_CONCURRENT_TASKS,
  MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE,
  parseMaximumConcurrentTasksEnvironmentValue,
  parseSchedulingSettingsFile,
} from '../../domains/scheduling/scheduling-settings.js'
import {
  SchedulingSettingsService,
  SchedulingSettingsServiceError,
} from '../../services/scheduling-settings-service.js'
import { TASK_QUEUE_FALLBACK_EVENT_FILENAME } from '../../core/task-queue-events.js'

function createStorage(): {
  readonly directory: string
  readonly controlDirectory: string
  readonly storagePath: string
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduling-settings-'))
  const controlDirectory = path.join(directory, 'task-queue')
  return {
    directory,
    controlDirectory,
    storagePath: path.join(controlDirectory, 'settings.json'),
  }
}

function assertServiceError(
  error: unknown,
  code: SchedulingSettingsServiceError['code'],
): boolean {
  assert.ok(error instanceof SchedulingSettingsServiceError)
  assert.equal(error.code, code)
  return true
}

test('scheduling settings schema and environment parser enforce the 1 through 64 integer contract', () => {
  assert.equal(parseMaximumConcurrentTasksEnvironmentValue(undefined), undefined)
  assert.equal(parseMaximumConcurrentTasksEnvironmentValue(' 3 '), 3)
  assert.equal(parseMaximumConcurrentTasksEnvironmentValue('64'), 64)
  for (const invalid of ['', '0', '65', '-1', '1.5', '3e0', '03']) {
    assert.throws(() => parseMaximumConcurrentTasksEnvironmentValue(invalid))
  }

  assert.deepEqual(
    parseSchedulingSettingsFile({
      version: 1,
      maximumConcurrentTasks: 3,
    }),
    { version: 1, maximumConcurrentTasks: 3 },
  )
  for (const invalid of [
    null,
    [],
    { version: 2, maximumConcurrentTasks: 3 },
    { version: 1, maximumConcurrentTasks: 0 },
    { version: 1, maximumConcurrentTasks: 3.5 },
    { version: 1, maximumConcurrentTasks: 3, unknown: true },
  ]) {
    assert.throws(() => parseSchedulingSettingsFile(invalid))
  }
})

test('scheduling settings default is durable when explicitly saved and reloads with private permissions', async () => {
  const storage = createStorage()
  try {
    const service = new SchedulingSettingsService({
      storagePath: storage.storagePath,
      environment: {},
    })
    assert.deepEqual(await service.snapshot(), {
      maximumConcurrentTasks: DEFAULT_MAXIMUM_CONCURRENT_TASKS,
      constraints: { minimum: 1, maximum: 64 },
      source: 'default',
      editable: true,
    })
    assert.equal(fs.existsSync(storage.storagePath), false)

    const saved = await service.updateMaximumConcurrentTasks(3)
    assert.equal(saved.source, 'persisted')
    assert.equal(saved.maximumConcurrentTasks, 3)
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.storagePath, 'utf8')), {
      version: 1,
      maximumConcurrentTasks: 3,
    })
    assert.equal(fs.statSync(storage.controlDirectory).mode & 0o777, 0o700)
    assert.equal(fs.statSync(storage.storagePath).mode & 0o777, 0o600)
    assert.deepEqual(
      fs.readdirSync(storage.controlDirectory).filter((entry) => entry.endsWith('.tmp')),
      [],
    )

    const firstInode = fs.statSync(storage.storagePath).ino
    assert.deepEqual(await service.updateMaximumConcurrentTasks(3), saved)
    assert.equal(fs.statSync(storage.storagePath).ino, firstInode)

    const restarted = new SchedulingSettingsService({
      storagePath: storage.storagePath,
      environment: {},
    })
    assert.deepEqual(await restarted.snapshot(), saved)
  } finally {
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('environment maximum takes precedence and makes every update read-only', async () => {
  const storage = createStorage()
  try {
    const persisted = new SchedulingSettingsService({
      storagePath: storage.storagePath,
      environment: {},
    })
    await persisted.updateMaximumConcurrentTasks(2)

    const environmentManaged = new SchedulingSettingsService({
      storagePath: storage.storagePath,
      environment: {
        [MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE]: '5',
      },
    })
    assert.deepEqual(await environmentManaged.snapshot(), {
      maximumConcurrentTasks: 5,
      constraints: { minimum: 1, maximum: 64 },
      source: 'environment',
      editable: false,
    })
    await assert.rejects(
      environmentManaged.updateMaximumConcurrentTasks(5),
      (error: unknown) => assertServiceError(error, 'managed_by_environment'),
    )
    assert.equal(
      JSON.parse(fs.readFileSync(storage.storagePath, 'utf8')).maximumConcurrentTasks,
      2,
    )
  } finally {
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('invalid environment and persisted configurations fail closed with typed startup errors', async () => {
  for (const environmentValue of ['', '0', '65', '1.5', '03']) {
    const storage = createStorage()
    try {
      const service = new SchedulingSettingsService({
        storagePath: storage.storagePath,
        environment: {
          [MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE]: environmentValue,
        },
      })
      await assert.rejects(
        service.snapshot(),
        (error: unknown) => assertServiceError(error, 'configuration_invalid'),
      )
    } finally {
      fs.rmSync(storage.directory, { recursive: true, force: true })
    }
  }

  for (const content of [
    '{',
    JSON.stringify({ version: 2, maximumConcurrentTasks: 3 }),
    JSON.stringify({ version: 1, maximumConcurrentTasks: 0 }),
    JSON.stringify({ version: 1, maximumConcurrentTasks: 3, extra: true }),
  ]) {
    const storage = createStorage()
    try {
      fs.mkdirSync(storage.controlDirectory, { recursive: true })
      fs.writeFileSync(storage.storagePath, content)
      const service = new SchedulingSettingsService({
        storagePath: storage.storagePath,
        environment: {},
      })
      await assert.rejects(
        service.snapshot(),
        (error: unknown) => assertServiceError(error, 'configuration_invalid'),
      )
    } finally {
      fs.rmSync(storage.directory, { recursive: true, force: true })
    }
  }
})

test('failed atomic persistence leaves the previously effective in-memory value unchanged', async () => {
  const storage = createStorage()
  try {
    const service = new SchedulingSettingsService({
      storagePath: storage.storagePath,
      environment: {},
    })
    await service.updateMaximumConcurrentTasks(2)

    const movedControlDirectory = `${storage.controlDirectory}-moved`
    fs.renameSync(storage.controlDirectory, movedControlDirectory)
    fs.writeFileSync(storage.controlDirectory, 'blocks-directory-recreation')

    await assert.rejects(
      service.updateMaximumConcurrentTasks(4),
      (error: unknown) => assertServiceError(error, 'settings_persistence_failed'),
    )
    assert.equal((await service.snapshot()).maximumConcurrentTasks, 2)
    assert.equal((await service.snapshot()).source, 'persisted')
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(movedControlDirectory, 'settings.json'), 'utf8'),
      ).maximumConcurrentTasks,
      2,
    )
    const events = fs.readFileSync(
      path.join(storage.directory, 'logs', TASK_QUEUE_FALLBACK_EVENT_FILENAME),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as { event: string })
    assert.ok(events.some(
      (event) => event.event === 'scheduling_settings.persistence_failed',
    ))
  } finally {
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})

test('concurrent service writes serialize without a torn settings file', async () => {
  const storage = createStorage()
  try {
    const service = new SchedulingSettingsService({
      storagePath: storage.storagePath,
      environment: {},
    })
    const [first, second] = await Promise.all([
      service.updateMaximumConcurrentTasks(4),
      service.updateMaximumConcurrentTasks(6),
    ])
    assert.equal(first.maximumConcurrentTasks, 4)
    assert.equal(second.maximumConcurrentTasks, 6)
    assert.equal((await service.snapshot()).maximumConcurrentTasks, 6)
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.storagePath, 'utf8')), {
      version: 1,
      maximumConcurrentTasks: 6,
    })
  } finally {
    fs.rmSync(storage.directory, { recursive: true, force: true })
  }
})
