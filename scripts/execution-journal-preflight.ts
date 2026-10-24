import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  inspectWorkspaceActivationReadiness,
  type ExecutionJournalPreflightProblem,
  type ExecutionJournalPreflightReport,
} from '../services/execution-journal-preflight.js'
import { validateJournalTenantId } from '../services/workspace-execution-journal-registry.js'

/**
 * Operator entry point for the activation preflight (AC21).
 *
 * A script rather than a route: this is the question an operator asks *before*
 * configuring the app to run with the journal on, and requiring a running
 * server to answer "is this workspace safe to activate" would be backwards. It
 * also cannot provision anything through a live composition, which is the one
 * property the preflight most needs.
 *
 * Usage:
 *   npm run journal:preflight -- --workspace <path> [--tenant <id>] [--json]
 *
 * Exit codes: 0 ready, 1 blocked, 2 usage error.
 */

interface PreflightArguments {
  readonly workspacePath: string
  readonly tenantId: string
  readonly json: boolean
}

const USAGE =
  'Usage: npm run journal:preflight -- --workspace <path> [--tenant <id>] [--json]'

export function parsePreflightArguments(
  argv: readonly string[],
): PreflightArguments {
  let workspacePath: string | undefined
  let tenantId: string | undefined
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--workspace':
      case '--tenant': {
        const value = argv[index + 1]
        if (!value || value.startsWith('--')) {
          throw new Error(`${argument} requires a value.\n${USAGE}`)
        }
        if (argument === '--workspace') workspacePath = value
        else tenantId = value
        index += 1
        break
      }
      case '--json':
        json = true
        break
      default:
        throw new Error(`Unknown argument: ${argument}\n${USAGE}`)
    }
  }

  if (!workspacePath) throw new Error(`--workspace is required.\n${USAGE}`)

  return {
    workspacePath: path.resolve(workspacePath),
    // The same boundary the runtime applies, not a second, laxer one. A
    // preflight that accepted a tenant startup would reject would answer a
    // question nobody asked.
    tenantId: validateJournalTenantId(tenantId ?? process.env.TEAM_TENANT_ID),
    json,
  }
}

/** Where a problem is, in the shape that address actually has. */
function locate(problem: ExecutionJournalPreflightProblem): string {
  if (problem.scope) {
    return ` [${problem.scope.sessionId}/${problem.scope.runId}/${problem.scope.assignmentId}]`
  }
  if (problem.conversationScope) {
    return ` [conversation:${problem.conversationScope.sessionId}/${problem.conversationScope.activityId}]`
  }
  return ''
}

export function formatPreflightReport(
  report: ExecutionJournalPreflightReport,
): string {
  const lines: string[] = []
  lines.push(
    report.verdict === 'ready'
      ? 'READY — this workspace can be activated.'
      : 'BLOCKED — resolve the problems below before activating.',
  )
  lines.push('')
  lines.push(`  environment tenant : ${report.environmentTenantId}`)
  lines.push(`  journals found     : ${report.journalCount}`)
  lines.push(`  readable journals  : ${report.enrolledJournalCount}`)
  lines.push(
    `  sealed tenants     : ${report.tenantIds.length === 0 ? '(none)' : report.tenantIds.join(', ')}`,
  )
  lines.push(`  unresolved dispatches: ${report.unresolvedDispatchCount}`)
  lines.push(`  journal divergences: ${report.journalDivergences.length}`)
  if (report.pinnableTenantId !== undefined) {
    lines.push(`  tenant to pin      : ${report.pinnableTenantId}`)
  }

  if (report.problems.length > 0) {
    lines.push('')
    lines.push('Problems:')
    for (const problem of report.problems) {
      // A conversation cannot be named by an assignment triple, and printing
      // nothing leaves an operator with a workspace-wide search for the one
      // activity the report already identified.
      lines.push(`  - ${problem.kind}${locate(problem)}`)
      lines.push(`    ${problem.detail}`)
    }
  }

  if (report.journalDivergences.length > 0) {
    lines.push('')
    lines.push('Journal divergences (reported, not blocking):')
    for (const divergence of report.journalDivergences) {
      lines.push(
        `  - ${divergence.site} [${divergence.scope.sessionId}/${divergence.scope.runId}/${divergence.scope.assignmentId}]` +
          `${divergence.recordedAt === undefined ? '' : ` at ${divergence.recordedAt}`}`,
      )
      lines.push(`    ${divergence.detail}`)
    }
    lines.push(
      '  A cancellation could not reach the journal, so the durable record ' +
        'and the task record disagree for these assignments.',
    )
  }

  if (report.unresolvedDispatchCount > 0) {
    lines.push('')
    lines.push(
      'Note: unresolved dispatches are reported, not blocking. They become a ' +
        'gate once an operator resolution path exists.',
    )
  }

  return `${lines.join('\n')}\n`
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return Boolean(entry && pathToFileURL(path.resolve(entry)).href === moduleUrl)
}

if (isMainModule(import.meta.url)) {
  let parsed: PreflightArguments
  try {
    parsed = parsePreflightArguments(process.argv.slice(2))
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(2)
  }

  inspectWorkspaceActivationReadiness({
    workspacePath: parsed.workspacePath,
    environmentTenantId: parsed.tenantId,
  })
    .then((report) => {
      process.stdout.write(
        parsed.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : formatPreflightReport(report),
      )
      process.exit(report.verdict === 'ready' ? 0 : 1)
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `Preflight failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exit(2)
    })
}
