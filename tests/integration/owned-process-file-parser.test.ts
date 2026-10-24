import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { requiredValue } from '../../core/required-value.js'
import { runFileParserProcess } from '../../core/file-parser-launcher.js'
import {
  OWNED_PROCESS_ID_ENV,
  OWNED_PROCESS_SCOPE_ENV,
  claimRecordSchema,
  intentRecordSchema,
  ownedProcessScopeFolders,
  readScopeRecord,
} from '../../core/owned-processes/owned-process-records.js'
import { publishOwnedProcessScope } from '../../core/owned-processes/owned-process-scope.js'
import { prepareOwnedProcess } from '../../core/owned-processes/owned-process-spawn.js'

// Requirement (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// sections 2 to 4): a file parser started by a process that holds an
// ownership scope is an owned process like a Team child. Its intent is
// recorded before the spawn, with the spawner's own owned process id as its
// parent, and the parser runs as the target of a host that claimed the
// intent and leads the parser's process group, so a closer can find and stop
// it. POSIX only; on Windows nothing changes.

/** A parser stand-in: records its pid, its group and the owned id it was given, then exits 0. */
const PARSER_SCRIPT = [
  "const fs = require('node:fs')",
  "const { execFileSync } = require('node:child_process')",
  "const group = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', env: {} }).trim())",
  "fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, group, ownedProcessId: process.env.TEAM_RUNTIME_OWNED_PROCESS_ID }))",
].join('\n')

interface ParserReport {
  readonly pid: number
  readonly group: number
  readonly ownedProcessId: unknown
}

function readReport(filePath: string): ParserReport {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.ok(
    typeof parsed === 'object' && parsed !== null &&
      typeof Reflect.get(parsed, 'pid') === 'number' &&
      typeof Reflect.get(parsed, 'group') === 'number',
    'an unreadable parser report',
  )
  return { pid: Number(Reflect.get(parsed, 'pid')), group: Number(Reflect.get(parsed, 'group')), ownedProcessId: Reflect.get(parsed, 'ownedProcessId') }
}

test('a file parser started under a scope is recorded as an owned process and runs in the group of the host that claimed it', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-file-parser-'))
  try {
    const scopePath = await publishOwnedProcessScope({
      workspacePath,
      sessionId: 'session-file-parser',
      taskId: 'task-file-parser',
      executionAttemptNumber: 1,
    })
    // The spawner: a Team child of the attempt, itself an owned process.
    const spawner = requiredValue(await prepareOwnedProcess({
      environment: { [OWNED_PROCESS_SCOPE_ENV]: scopePath },
      kind: 'team',
      childRunId: 'team-child-run',
      spawnerRunId: 'root-run',
      spawnerAssignmentId: 'root-run',
    }), 'spawner intent')
    const reportPath = path.join(workspacePath, 'parser-report.json')

    await runFileParserProcess({
      command: process.execPath,
      args: ['-e', PARSER_SCRIPT, reportPath],
      cwd: workspacePath,
      env: {
        ...process.env,
        [OWNED_PROCESS_SCOPE_ENV]: scopePath,
        [OWNED_PROCESS_ID_ENV]: spawner.ownedProcessId,
        TEAM_ROOT_SESSION_ID: 'root-run',
        TEAM_SESSION_ID: 'team-child-run',
      },
    })

    const folders = ownedProcessScopeFolders(scopePath)
    const intentIds = fs.readdirSync(folders.intents)
      .map((name) => name.replace(/\.json$/u, ''))
      .filter((id) => id !== spawner.ownedProcessId)
    assert.equal(intentIds.length, 1, 'the file parser is recorded as one owned process')
    const parserId = requiredValue(intentIds[0], 'parser intent id')
    const intent = await readScopeRecord({
      target: path.join(folders.intents, `${parserId}.json`),
      schema: intentRecordSchema,
      expectedOwnedProcessId: parserId,
    })
    assert.equal(intent.kind, 'present')
    if (intent.kind !== 'present') return
    assert.deepEqual(
      { kind: intent.record.kind, parent: intent.record.parentOwnedProcessId, childRunId: intent.record.childRunId },
      { kind: 'file-parser', parent: spawner.ownedProcessId, childRunId: null },
    )
    const claim = await readScopeRecord({
      target: path.join(folders.claims, `${parserId}.json`),
      schema: claimRecordSchema,
      expectedOwnedProcessId: parserId,
    })
    assert.ok(claim.kind === 'present' && claim.record.claimant === 'host', 'the parser\'s host claimed its intent')
    const report = readReport(reportPath)
    assert.deepEqual(
      {
        parserInHostGroup: report.group === claim.record.pid,
        hostLeadsGroup: claim.record.processGroupId === claim.record.pid,
        parserIsNotHost: report.pid !== claim.record.pid,
        parserOwnedId: report.ownedProcessId,
      },
      { parserInHostGroup: true, hostLeadsGroup: true, parserIsNotHost: true, parserOwnedId: parserId },
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
