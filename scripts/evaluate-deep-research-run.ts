import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluateDeepResearchRunDirectory,
  loadDeepResearchEvaluationCorpus,
  loadDeepResearchEvaluationReport,
} from '../services/deep-research-evaluation-service.js'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const DEFAULT_CORPUS_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'deep-research',
  'evaluation-corpus.json',
)

const options = parseArguments(process.argv.slice(2))
const corpus = loadDeepResearchEvaluationCorpus(
  options.corpusPath ?? DEFAULT_CORPUS_PATH,
)
const evaluationCase = corpus.cases.find(
  (candidate) => candidate.id === options.caseId,
)
if (!evaluationCase) {
  throw new Error(
    `Unknown evaluation case '${options.caseId}'. Available cases: ` +
    corpus.cases.map((candidate) => candidate.id).join(', '),
  )
}

const runPath = path.resolve(options.runPath)
const outputPath = path.resolve(
  options.outputPath ??
  path.join(runPath, 'deep-research-evaluation.json'),
)
const baseline = options.baselinePath
  ? loadDeepResearchEvaluationReport(options.baselinePath)
  : undefined
const report = evaluateDeepResearchRunDirectory({
  runPath,
  evaluationCase,
  ...(baseline ? { baseline } : {}),
  outputPath,
  ...(options.elapsedMs === undefined
    ? {}
    : { elapsedMs: options.elapsedMs }),
  ...(options.costUsd === undefined
    ? {}
    : { costUsd: options.costUsd }),
  ...(options.evaluatedAt === undefined
    ? {}
    : { evaluatedAt: options.evaluatedAt }),
})

if (options.retainPath) {
  const retainPath = path.resolve(options.retainPath)
  if (fs.existsSync(retainPath)) {
    throw new Error(
      `Retention target already exists and will not be overwritten: ${retainPath}`,
    )
  }
  fs.mkdirSync(path.dirname(retainPath), { recursive: true })
  fs.cpSync(runPath, retainPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  })
}

process.stdout.write(`${JSON.stringify({
  evaluationId: report.evaluationId,
  caseId: report.caseId,
  decision: report.decision,
  compositeScore: report.compositeScore,
  outputPath,
  retainedPath: options.retainPath
    ? path.resolve(options.retainPath)
    : null,
  blockingReasons: report.blockingReasons,
}, null, 2)}\n`)
process.exitCode = report.decision === 'PASS' ? 0 : 1

interface CliOptions {
  runPath: string
  caseId: string
  corpusPath?: string
  baselinePath?: string
  outputPath?: string
  retainPath?: string
  elapsedMs?: number
  costUsd?: number
  evaluatedAt?: string
}

function parseArguments(args: readonly string[]): CliOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      usage()
    }
    values.set(name, value)
  }
  const allowed = new Set([
    '--run',
    '--case',
    '--corpus',
    '--baseline',
    '--output',
    '--retain',
    '--elapsed-ms',
    '--cost-usd',
    '--evaluated-at',
  ])
  for (const name of values.keys()) {
    if (!allowed.has(name)) usage()
  }
  const runPath = values.get('--run')
  const caseId = values.get('--case')
  if (!runPath || !caseId) usage()
  const corpusPath = values.get('--corpus')
  const baselinePath = values.get('--baseline')
  const outputPath = values.get('--output')
  const retainPath = values.get('--retain')
  const elapsedMsValue = values.get('--elapsed-ms')
  const costUsdValue = values.get('--cost-usd')
  const evaluatedAtValue = values.get('--evaluated-at')
  return {
    runPath,
    caseId,
    ...(corpusPath !== undefined ? { corpusPath } : {}),
    ...(baselinePath !== undefined ? { baselinePath } : {}),
    ...(outputPath !== undefined ? { outputPath } : {}),
    ...(retainPath !== undefined ? { retainPath } : {}),
    ...(elapsedMsValue !== undefined
      ? {
          elapsedMs: positiveNumber(
            elapsedMsValue,
            '--elapsed-ms',
            true,
          ),
        }
      : {}),
    ...(costUsdValue !== undefined
      ? {
          costUsd: positiveNumber(
            costUsdValue,
            '--cost-usd',
            true,
          ),
        }
      : {}),
    ...(evaluatedAtValue !== undefined
      ? {
          evaluatedAt: timestamp(
            evaluatedAtValue,
            '--evaluated-at',
          ),
        }
      : {}),
  }
}

function positiveNumber(
  value: string,
  name: string,
  allowZero: boolean,
): number {
  const parsed = Number(value)
  if (
    !Number.isFinite(parsed) ||
    (allowZero ? parsed < 0 : parsed <= 0)
  ) {
    throw new Error(`${name} must be a finite non-negative number.`)
  }
  return parsed
}

function timestamp(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp.`)
  }
  return value
}

function usage(): never {
  throw new Error(
    'Usage: npm run evaluate:deep-research -- --run <run-directory> ' +
    '--case <corpus-case-id> [--baseline <report.json>] ' +
    '[--output <report.json>] [--retain <directory>] ' +
    '[--elapsed-ms <number>] [--cost-usd <number>]',
  )
}
