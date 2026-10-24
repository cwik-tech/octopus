/**
 * Team Runtime — Gate Checker
 *
 * Evaluates gate conditions between levels.
 * Gates must pass before the next level can activate.
 */

import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { DEFAULT_GATE_TRANSFORM_TIMEOUT_MS, DEFAULT_AUXILIARY_LLM_TIMEOUT_MINUTES } from '../core/constants.js'
import { roundUsd } from '../core/budget-ledger.js'
import type { GateConfig, GateCondition, GateResult, GateTransform, RuntimeState, LoadedAgent } from '../core/types.js'
import { runAgent } from '../domains/agent-execution/agent-runner.js'
import { toModelSelectionRecord } from '../contracts/agent-model-selection.js'
import { logAgentRun } from '../domains/runtime/logger.js'
import {
  parsePlan,
  areAllSprintsComplete,
  areAllSprintsSuccessful,
} from '../parsers/plan-parser.js'
import { parseVerdict } from '../core/verdict-parser.js'
import { buildArtifactMetadata, parseMarkdownArtifact, writeMarkdownArtifact } from '../domains/runtime/artifacts.js'
import { resolveExistingPathInside, resolveRelativePathInside } from '../core/path-safety.js'

const MAX_JSON_GATE_BYTES = 1024 * 1024

/**
 * Exit-code contract shared with gate transform scripts (see
 * teams/research-team/scripts/prepare-correction-wave.mjs and
 * prepare-resynthesis-wave.mjs): a script exits with this code only when it
 * refuses the route during its write-free preflight phase (e.g. insufficient
 * remaining deadline budget). The runtime treats this as "route unavailable"
 * and skips the gate instead of blocking the run.
 */
const ROUTE_UNAVAILABLE_EXIT_CODE = 69

export type GateTransformResult = {
  outputPath: string
  error?: string
  cost: number
  routeUnavailable?: boolean
}

/**
 * Evaluate a gate condition.
 * Returns { passed, reason } indicating whether the gate allows progression.
 */
export async function checkGate(
  gate: GateConfig,
  workspacePath: string,
  state: RuntimeState,
  agents?: Map<string, LoadedAgent>,
  planPath?: string,
  signal?: AbortSignal,
  /** Named on the validator's own run record, when the caller knows it. */
  teamName?: string,
): Promise<GateResult> {
  return evaluateCondition(gate.condition, workspacePath, state, agents, planPath, signal, teamName)
}

/**
 * Runs a gate's validator Agent, and says which model it ran on.
 *
 * Shared by both validator gates because the rule is the same for both, and
 * because a gate is one of the more consequential things a model does in a run:
 * it decides whether work advances. It used to leave no account of itself at
 * all — no telemetry, no record of the pair — because the dispatch never
 * received the assignment it belonged to.
 *
 * The pair is the Agent's own, exactly as it already was. These are Agents, not
 * the application's own background work: resolving them against the application
 * default would report a model the Agent never ran on.
 */
async function runValidatorAgent(params: {
  validator: LoadedAgent
  validatorName: string
  systemPrompt: string
  userMessage: string
  assignmentPath: string
  state?: RuntimeState
  teamName?: string
  signal?: AbortSignal
}): Promise<
  | { ok: true; text: string }
  | { ok: false; reason: string }
> {
  // Nothing is asked, and nothing is recorded, for a gate nobody is waiting
  // for. The rethrow on an aborted signal is this module's existing behaviour
  // and is preserved; what changes is that it happens before a dispatch rather
  // than through one.
  if (params.signal?.aborted) {
    throw new Error(`Gate validator '${params.validatorName}' was cancelled.`)
  }
  // No pair anybody chose is no pair to run on. Dispatching with an empty
  // provider would ask a question nothing can answer and record a model that
  // does not exist, so the gate refuses instead — which fails in the safe
  // direction, since a gate that cannot check work must not approve it.
  const selection = params.validator.selection
  if (!selection) {
    return {
      ok: false,
      reason:
        `Validator '${params.validatorName}' has no usable provider and model, ` +
        'so the gate was not evaluated.',
    }
  }

  const startedAt = Date.now()
  const record = toModelSelectionRecord(selection, 'agent')
  /**
   * Records one terminal event, and never becomes the gate's answer.
   *
   * The pre-send record is different and stays strict: refusing to decide a
   * gate on a model nothing can account for is the point. Afterwards the
   * validator has already answered, and a journal that breaks in between must
   * not turn a verdict into a thrown error — `checkGate` returns results, and a
   * caller that gets an exception has no gate result at all.
   */
  const recordTerminal = (event: Parameters<typeof logAgentRun>[1]): void => {
    try {
      logAgentRun(params.assignmentPath, event)
    } catch {
      // Not silent. The gate still answers, but a lifecycle record that could
      // not be written is a fact somebody has to be able to find — reported on
      // the process boundary, because the journal that would normally hold it
      // is the thing that just failed.
      //
      // Structured, and identity only. The raw error is deliberately dropped:
      // its message carries filesystem paths, and a fixed category says
      // everything a reader needs.
      console.error(JSON.stringify({
        event: 'runtime.agent_run_record_write_failed',
        error: 'record_write_failed',
        lifecycle: event.event,
        agent_name: event.agent_name,
        session_id: event.session_id,
      }))
    }
  }
  const runEvent = {
    session_id: params.state?.sessionId ?? '',
    ...whenDefined(params.state?.rootSessionId, (root_session_id) => ({
      root_session_id,
    })),
    assignment_path: params.assignmentPath,
    team: params.teamName ?? '',
    agent_name: params.validatorName,
    agent_type: 'agent' as const,
    model: selection.model,
    provider: selection.provider,
  }
  // Written before the send, so a gate that fails or is interrupted still
  // leaves an account of the model that was about to decide it — and a record
  // that cannot be written means the model is not used at all. A gate deciding
  // a run's progress on a model nothing recorded is the account this exists to
  // prevent.
  try {
    logAgentRun(params.assignmentPath, {
      timestamp: new Date(startedAt).toISOString(),
      event: 'start',
      ...runEvent,
      model_selection: record,
    })
  } catch {
    return {
      ok: false,
      reason:
        `The model selected for validator '${params.validatorName}' could not ` +
        'be recorded, so the gate was not evaluated.',
    }
  }

  try {
    const result = await runAgent({
      systemPrompt: params.systemPrompt,
      userMessage: params.userMessage,
      model: selection.model,
      thinking: params.validator.thinking,
      provider: selection.provider,
      ...whenDefined(params.validator.providerConfig, (providerConfig) => ({
        providerConfig,
      })),
      // The assignment and session, so this call is no longer invisible to the
      // run's own provider telemetry.
      //
      // Deliberately *not* `agentName`. A dispatch that carries an agent
      // identity is routed through the parent's worker/tool loop when one is
      // injected (`mcp-worker-turn-client.ts:146`), and that comment says why:
      // internal runtime calls have no agent identity and continue through
      // their normal provider. This capability is about disclosing which model
      // a gate used, not about moving the gate onto another route — the name
      // belongs on the record below, which is what a person reads.
      outputPath: params.assignmentPath,
      ...whenDefined(params.state?.sessionId, (sessionId) => ({ sessionId })),
      ...whenDefined(params.state?.rootSessionId, (rootSessionId) => ({
        rootSessionId,
      })),
      timeoutMinutes: DEFAULT_AUXILIARY_LLM_TIMEOUT_MINUTES,
      ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
    })
    if (params.state) {
      params.state.totalCost = roundUsd(params.state.totalCost + (result.cost ?? 0))
    }
    recordTerminal({
      timestamp: new Date().toISOString(),
      event: 'end',
      ...runEvent,
      duration_ms: Date.now() - startedAt,
    })
    return { ok: true, text: result.text.trim() }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    // Every start gets a terminal record, cancellation included. Without this a
    // run interrupted mid-gate would leave a validator that started and never
    // finished, which reads as a dispatch still in flight — and a journal that
    // cannot take it never replaces the reason the dispatch actually gave.
    recordTerminal({
      timestamp: new Date().toISOString(),
      event: 'fail',
      ...runEvent,
      duration_ms: Date.now() - startedAt,
      status: errMsg,
    })
    // Cancellation still propagates rather than becoming a gate verdict, which
    // is this module's existing behaviour.
    if (params.signal?.aborted) throw err
    return { ok: false, reason: errMsg }
  }
}

async function evaluateCondition(
  condition: GateCondition,
  workspacePath: string,
  state: RuntimeState,
  agents?: Map<string, LoadedAgent>,
  planPath?: string,
  signal?: AbortSignal,
  teamName?: string,
): Promise<GateResult> {
  switch (condition.type) {
    case 'artifact_exists':
      return checkArtifactExists(condition.artifact, workspacePath)

    case 'all_tasks_terminal':
      return checkAllTasksTerminal(planPath)

    case 'validation':
      return checkValidation(condition.validator, condition.strictness, workspacePath, agents, state, signal, teamName)

    case 'manual':
      return {
        passed: false,
        reason: 'Manual gate — requires explicit trigger by a permitted agent. Use /team-advance to bypass.',
      }

    case 'artifact_content':
      return checkArtifactContent(condition.artifact, condition.match, condition.match_type, workspacePath)

    case 'agent_verdict':
      return checkAgentVerdict(condition.validator, condition.verdict, workspacePath, agents, state, signal, teamName)

    case 'artifact_json':
      return checkArtifactJson(
        condition.artifact,
        condition.pointer,
        condition.operator,
        condition.value,
        workspacePath,
      )
  }
}

function resolveJsonPointer(document: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value: document }
  if (!pointer.startsWith('/')) return { found: false }

  let current: unknown = document
  for (const encodedSegment of pointer.slice(1).split('/')) {
    const segment = encodedSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return { found: false }
      const index = Number(segment)
      if (index >= current.length) return { found: false }
      current = current[index]
      continue
    }
    if (current === null || typeof current !== 'object') return { found: false }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false }
    current = (current as Record<string, unknown>)[segment]
  }
  return { found: true, value: current }
}

function checkArtifactJson(
  artifact: string,
  pointer: string,
  operator: 'equals',
  expected: string | number | boolean | null,
  workspacePath: string,
): GateResult {
  const candidatePath = resolveRelativePathInside(workspacePath, artifact)
  if (!candidatePath) {
    return { passed: false, reason: `Unsafe JSON artifact path: ${artifact}` }
  }
  const artifactPath = resolveExistingPathInside(workspacePath, candidatePath)
  if (!artifactPath) {
    return { passed: false, reason: `JSON artifact not found: ${artifact}` }
  }

  let stats: fs.Stats
  try {
    const linkStats = fs.lstatSync(candidatePath)
    if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
      return { passed: false, reason: `JSON artifact must be a regular file: ${artifact}` }
    }
    stats = fs.statSync(artifactPath)
  } catch (error) {
    return {
      passed: false,
      reason: `Failed to inspect JSON artifact '${artifact}': ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (stats.size > MAX_JSON_GATE_BYTES) {
    return { passed: false, reason: `JSON artifact exceeds ${MAX_JSON_GATE_BYTES} byte gate limit: ${artifact}` }
  }

  let document: unknown
  try {
    document = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
  } catch (error) {
    return {
      passed: false,
      reason: `Invalid JSON artifact '${artifact}': ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const resolved = resolveJsonPointer(document, pointer)
  if (!resolved.found) {
    return { passed: false, reason: `JSON pointer not found in '${artifact}': ${pointer}` }
  }
  const passed = operator === 'equals' && Object.is(resolved.value, expected)
  return passed
    ? {
        passed: true,
        reason: `JSON artifact '${artifact}' value at '${pointer}' equals ${JSON.stringify(expected)}`,
        boundary_artifacts: [artifact],
      }
    : {
        passed: false,
        reason: `JSON artifact '${artifact}' value at '${pointer}' did not equal ${JSON.stringify(expected)}`,
      }
}

/**
 * Check if a specific artifact file exists in the workspace.
 */
function checkArtifactExists(artifact: string, workspacePath: string): GateResult {
  const artifactPath = path.isAbsolute(artifact) ? artifact : path.join(workspacePath, artifact)

  if (fs.existsSync(artifactPath)) {
    return {
      passed: true,
      reason: `Artifact exists: ${artifact}`,
      boundary_artifacts: [artifact],
    }
  }

  return {
    passed: false,
    reason: `Required artifact not found: ${artifact}. Expected at: ${artifactPath}`,
  }
}

/**
 * Check if all tasks in the pipeline plan are in a terminal state.
 */
function checkAllTasksTerminal(planPath?: string): GateResult {
  if (!planPath) {
    return { passed: false, reason: 'No plan file configured for all_tasks_terminal gate' }
  }

  const plan = parsePlan(planPath)
  if (!plan) {
    return { passed: false, reason: `Cannot read plan file: ${planPath}` }
  }

  if (areAllSprintsComplete(plan)) {
    if (!areAllSprintsSuccessful(plan)) {
      const unsuccessful = [...plan.tasks.values()]
        .filter((task) => !['completed', 'validated'].includes(task.status))
        .map((task) => `${task.id} (${task.status})`)
      return {
        passed: false,
        reason: `Pipeline has unsuccessful terminal tasks: ${unsuccessful.join(', ')}`,
        boundary_artifacts: [planPath],
      }
    }
    return {
      passed: true,
      reason: 'All sprints complete — all tasks succeeded',
      boundary_artifacts: [planPath],
    }
  }

  // Build a summary of incomplete tasks
  const incomplete: string[] = []
  for (const task of plan.tasks.values()) {
    if (task.status !== 'completed' && task.status !== 'validated' && task.status !== 'failed' && task.status !== 'blocked') {
      incomplete.push(`${task.id} (${task.status})`)
    }
  }

  return {
    passed: false,
    reason: `Tasks not yet terminal: ${incomplete.join(', ')}`,
  }
}

/**
 * Check if a workspace artifact's content matches a given string or regex.
 */
async function checkArtifactContent(
  artifact: string,
  match: string,
  match_type: 'contains' | 'regex' | undefined,
  workspacePath: string,
): Promise<GateResult> {
  const artifactPath = path.isAbsolute(artifact) ? artifact : path.join(workspacePath, artifact)

  if (!fs.existsSync(artifactPath)) {
    return { passed: false, reason: `Artifact not found: ${artifact}` }
  }

  let content: string
  try {
    content = fs.readFileSync(artifactPath, 'utf-8')
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return { passed: false, reason: `Failed to read artifact '${artifact}': ${errMsg}` }
  }

  // Match against the body content, not the YAML metadata envelope.
  content = parseMarkdownArtifact(content).body

  if (match_type === 'regex') {
    let regex: RegExp
    try {
      regex = new RegExp(match, 'i')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { passed: false, reason: `Invalid regex: ${errMsg}` }
    }

    if (regex.test(content)) {
      return {
        passed: true,
        reason: `Artifact '${artifact}' matches regex: ${match}`,
        boundary_artifacts: [artifact],
      }
    }
    return { passed: false, reason: `Artifact '${artifact}' does not match regex: ${match}` }
  }

  // Default: contains (case-insensitive)
  if (content.toLowerCase().includes(match.toLowerCase())) {
    return {
      passed: true,
      reason: `Artifact '${artifact}' contains: ${match}`,
      boundary_artifacts: [artifact],
    }
  }
  return { passed: false, reason: `Artifact '${artifact}' does not contain: ${match}` }
}

/**
 * Run a validator agent and check whether its response matches the expected verdict token.
 * The validator receives workspace contents and responds with a single token on the first non-empty line.
 */
async function checkAgentVerdict(
  validatorName: string,
  verdict: string,
  workspacePath: string,
  agents?: Map<string, LoadedAgent>,
  state?: RuntimeState,
  signal?: AbortSignal,
  teamName?: string,
): Promise<GateResult> {
  if (!agents) {
    return { passed: false, reason: 'No agents available for verdict check' }
  }

  const validator = agents.get(validatorName)
  if (!validator) {
    return { passed: false, reason: `Validator agent not found: ${validatorName}` }
  }

  // Collect workspace artifacts for context
  let artifactList = 'No artifacts found'
  try {
    const artifacts = collectWorkspaceArtifacts(workspacePath)
    if (artifacts.length > 0) {
      artifactList = artifacts.join('\n\n---\n\n')
    }
  } catch { /* workspace might not exist yet */ }

  const userMessage =
    `# Verdict Request\n\n` +
    `Review the following workspace artifacts and provide a verdict.\n\n` +
    `## Workspace Contents\n\n${artifactList}\n\n` +
    `## Instructions\n\n` +
    `On the FIRST non-empty line, respond with exactly one token (your verdict).\n` +
    `If you include any explanation, put it on later lines only.`

  const dispatched = await runValidatorAgent({
    validator,
    validatorName,
    systemPrompt: validator.systemPrompt,
    userMessage,
    assignmentPath: workspacePath,
    ...whenDefined(state, (definedValue) => ({ state: definedValue })),
    ...whenDefined(teamName, (definedValue) => ({ teamName: definedValue })),
    ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
  })
  if (!dispatched.ok) {
    return { passed: false, reason: `Verdict check error: ${dispatched.reason}` }
  }

  const text = dispatched.text
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? ''

  if (firstLine.toLowerCase() === verdict.toLowerCase()) {
    return { passed: true, reason: `Validator '${validatorName}' returned expected verdict '${verdict}': ${text.slice(0, 200)}` }
  }

  return {
    passed: false,
    reason: `Validator '${validatorName}' returned '${firstLine}', expected '${verdict}': ${text.slice(0, 200)}`,
  }
}

/**
 * Run a validator agent and check its verdict.
 * The validator receives workspace contents and returns PASS/FAIL with reasoning.
 */
async function checkValidation(
  validatorName: string,
  strictness: 'hard' | 'soft' | 'off',
  workspacePath: string,
  agents?: Map<string, LoadedAgent>,
  state?: RuntimeState,
  signal?: AbortSignal,
  teamName?: string,
): Promise<GateResult> {
  if (strictness === 'off') {
    return { passed: true, reason: 'Validation gate disabled (strictness: off)' }
  }

  if (!agents) {
    return { passed: false, reason: 'No agents available for validation' }
  }

  const validator = agents.get(validatorName)
  if (!validator) {
    return { passed: false, reason: `Validator agent '${validatorName}' not found in agent roster` }
  }

  // List workspace artifacts for context
  let artifactList = 'No artifacts found'
  try {
    const artifacts = collectWorkspaceArtifacts(workspacePath)
    if (artifacts.length > 0) {
      artifactList = artifacts.join('\n\n---\n\n')
    }
  } catch { /* workspace might not exist yet */ }

  const userMessage =
    `# Validation Request\n\n` +
    `Review the following workspace artifacts and determine if the level's work meets quality standards.\n\n` +
    `## Workspace Contents\n\n${artifactList}\n\n` +
    `## Instructions\n\n` +
    `On the FIRST non-empty line, respond with exactly one token: PASS or FAIL.\n` +
    `If you include any explanation, put it on later lines only.\n\n` +
    `- PASS — if the work meets quality standards\n` +
    `- FAIL — if the work needs revision`

  const dispatched = await runValidatorAgent({
    validator,
    validatorName,
    systemPrompt: validator.systemPrompt,
    userMessage,
    assignmentPath: workspacePath,
    ...whenDefined(state, (definedValue) => ({ state: definedValue })),
    ...whenDefined(teamName, (definedValue) => ({ teamName: definedValue })),
    ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
  })
  if (!dispatched.ok) {
    // A soft gate still proceeds through a dispatch failure, exactly as before.
    if (strictness === 'soft') {
      return { passed: true, reason: `Validation error (soft gate — proceeding): ${dispatched.reason}` }
    }
    return { passed: false, reason: `Validation error: ${dispatched.reason}` }
  }

  const text = dispatched.text
  const verdict = parseVerdict(text, ['PASS', 'FAIL'])

  if (verdict === 'PASS') {
    return { passed: true, reason: `Validator '${validatorName}' approved: ${text.slice(0, 200)}` }
  }

  if (verdict === 'FAIL' && strictness === 'soft') {
    return {
      passed: true,
      reason: `Validator '${validatorName}' flagged issues (soft gate — proceeding): ${text.slice(0, 200)}`,
    }
  }

  if (verdict === 'FAIL') {
    return {
      passed: false,
      reason: `Validator '${validatorName}' rejected: ${text.slice(0, 200)}`,
    }
  }

  if (strictness === 'soft') {
    return {
      passed: true,
      reason: `Validator '${validatorName}' returned an invalid verdict (soft gate — proceeding): ${text.slice(0, 200)}`,
    }
  }

  return {
    passed: false,
    reason: `Validator '${validatorName}' returned an invalid verdict. Expected first line to be PASS or FAIL. Response: ${text.slice(0, 200)}`,
  }
}

/**
 * Run the gate transform after the gate condition passes.
 * Returns the output artifact path and cost (0 for scripts).
 */
export async function runGateTransform(
  transform: GateTransform,
  workspacePath: string,
  teamRoot?: string,
): Promise<GateTransformResult> {
  const inputPath = transform.input
    ? path.join(workspacePath, transform.input)
    : workspacePath

  const outputPath = transform.output
    ? path.join(workspacePath, transform.output)
    : path.join(workspacePath, 'gate-checks', 'transform-output.md')

  if (transform.type === 'script') {
    const script = transform.script
    if (!script) {
      return { outputPath, error: 'Script transform missing script path', cost: 0 }
    }

    return new Promise((resolve) => {
      const proc = spawn('node', [script], {
        cwd: teamRoot || workspacePath,
        env: {
          ...process.env,
          TRANSFORM_INPUT: inputPath,
          TRANSFORM_OUTPUT: outputPath,
          WORKSPACE_PATH: workspacePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      let settled = false
      const timeoutMs = transform.timeout_minutes != null && transform.timeout_minutes > 0
        ? transform.timeout_minutes * 60 * 1000
        : DEFAULT_GATE_TRANSFORM_TIMEOUT_MS
      const finish = (result: GateTransformResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(result)
      }
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      const timeout = setTimeout(() => {
        try { proc.kill('SIGTERM') } catch { /* Process exited while timing out. */ }
        finish({ outputPath, error: `Script transform timed out after ${Math.ceil(timeoutMs / 1000)} seconds`, cost: 0 })
      }, timeoutMs)

      proc.once('error', (error) => {
        finish({ outputPath, error: `Script transform failed to start: ${error.message}`, cost: 0 })
      })
      proc.once('close', (code) => {
        if (code !== 0) {
          finish({
            outputPath,
            error: `Script exited with code ${code}: ${stderr}`,
            cost: 0,
            ...(code === ROUTE_UNAVAILABLE_EXIT_CODE ? { routeUnavailable: true } : {}),
          })
        } else {
          finish({ outputPath, cost: 0 })
        }
      })
    })
  }

  if (transform.type === 'agent') {
    // TODO: implement via subagent system
    return {
      outputPath,
      error: 'Agent transforms not yet implemented — treated as pass-through',
      cost: 0,
    }
  }

  return { outputPath, error: `Unknown transform type: ${(transform as GateTransform).type}`, cost: 0 }
}

/**
 * Write a structured gate report to workspace/gate-checks/gate-{N}-{from}-to-{to}.md.
 * Called on every gate crossing regardless of transform presence.
 */
export async function writeGateReport(
  gate: GateConfig,
  gateIndex: number,
  gateResult: GateResult,
  workspacePath: string,
  transformResult?: GateTransformResult,
): Promise<void> {
  const gateChecksDir = path.join(workspacePath, 'gate-checks')
  if (!fs.existsSync(gateChecksDir)) {
    fs.mkdirSync(gateChecksDir, { recursive: true })
  }

  const reportName = `gate-${gateIndex}-${gate.from}-to-${gate.to}.md`
  const reportPath = path.join(gateChecksDir, reportName)

  const boundaryArtifacts = [
    ...(gateResult.boundary_artifacts ?? []),
    ...(transformResult && !transformResult.error ? [path.relative(workspacePath, transformResult.outputPath) || transformResult.outputPath] : []),
  ]
  const normalizedBoundaryArtifacts = [...new Set(boundaryArtifacts.filter(Boolean))]

  const lines: string[] = [
    `# Gate Report: ${gate.from} → ${gate.to}`,
    ``,
    `**Timestamp:** ${new Date().toISOString()}`,
    `**Gate Index:** ${gateIndex}`,
    ``,
    `## Gate Condition`,
    ``,
    `**Type:** ${gate.condition.type}`,
    `**Result:** ${gateResult.passed ? '✅ PASSED' : '❌ FAILED'}`,
    `**Reason:** ${gateResult.reason}`,
    ``,
  ]

  if (normalizedBoundaryArtifacts.length > 0) {
    lines.push(`## Boundary Contract`)
    lines.push(``)
    lines.push(`**Artifacts Crossing This Boundary:**`)
    for (const artifact of normalizedBoundaryArtifacts) {
      lines.push(`- ${artifact}`)
    }
    lines.push(``)
  }

  if (gate.transform) {
    lines.push(`## Transform`)
    lines.push(``)
    lines.push(`**Type:** ${gate.transform.type}`)
    if (gate.transform.type === 'script' && gate.transform.script) {
      lines.push(`**Script:** ${gate.transform.script}`)
    }
    if (gate.transform.type === 'agent' && gate.transform.agent) {
      lines.push(`**Agent:** ${gate.transform.agent}`)
    }
    if (gate.transform.input) lines.push(`**Input:** ${gate.transform.input}`)
    if (gate.transform.output) lines.push(`**Output:** ${gate.transform.output}`)
    if (gate.transform.strictness) lines.push(`**Strictness:** ${gate.transform.strictness}`)
    lines.push(``)
  }

  if (transformResult) {
    lines.push(`## Transform Result`)
    lines.push(``)
    lines.push(`**Output Path:** ${transformResult.outputPath}`)
    lines.push(`**Cost:** $${transformResult.cost.toFixed(4)}`)
    if (transformResult.error) {
      lines.push(`**Error:** ${transformResult.error}`)
    } else {
      lines.push(`**Status:** ✅ Success`)
    }
    lines.push(``)
  }

  writeMarkdownArtifact(
    reportPath,
    lines.join('\n'),
    buildArtifactMetadata({
      filePath: reportPath,
      rootDir: workspacePath,
      artifactType: 'validation',
      status: gateResult.passed ? 'passed' : 'failed',
      title: `Gate Report: ${gate.from} -> ${gate.to}`,
      level: gate.from,
      stageType: 'gate-check',
      verdict: gateResult.passed ? 'PASS' : 'FAIL',
    }),
  )

  const boundaryPath = path.join(gateChecksDir, `boundary-${gateIndex}-${gate.from}-to-${gate.to}.md`)
  const boundaryLines: string[] = [
    `# Boundary Contract: ${gate.from} → ${gate.to}`,
    ``,
    `**Timestamp:** ${new Date().toISOString()}`,
    `**Gate Result:** ${gateResult.passed ? 'PASS' : 'FAIL'}`,
    `**Condition Type:** ${gate.condition.type}`,
    `**Reason:** ${gateResult.reason}`,
    ``,
    `## Outputs`,
    ``,
  ]

  if (normalizedBoundaryArtifacts.length === 0) {
    boundaryLines.push(`_No boundary artifacts were emitted for this gate._`)
  } else {
    for (const artifact of normalizedBoundaryArtifacts) {
      boundaryLines.push(`- ${artifact}`)
    }
  }

  writeMarkdownArtifact(
    boundaryPath,
    boundaryLines.join('\n'),
    buildArtifactMetadata({
      filePath: boundaryPath,
      rootDir: workspacePath,
      artifactType: 'contract',
      status: gateResult.passed ? 'passed' : 'failed',
      title: `Boundary Contract: ${gate.from} -> ${gate.to}`,
      level: gate.from,
      stageType: 'gate-boundary',
      verdict: gateResult.passed ? 'PASS' : 'FAIL',
    }),
  )
}

const MAX_WORKSPACE_DEPTH = 4
const MAX_WORKSPACE_CHARS = 100 * 1024 // 100 KB

function collectWorkspaceArtifacts(workspacePath: string): string[] {
  const artifacts: string[] = []
  // Stack entries carry the directory path and its depth relative to workspacePath
  const stack: Array<{ dir: string; depth: number }> = [{ dir: workspacePath, depth: 0 }]
  let totalChars = 0

  while (stack.length > 0) {
    const item = stack.pop()
    if (!item) continue
    const { dir: currentDir, depth } = item

    if (depth > MAX_WORKSPACE_DEPTH) continue
    if (totalChars >= MAX_WORKSPACE_CHARS) break

    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (entry.name === 'gate-checks') continue // skip gate reports from validator context
        if (depth < MAX_WORKSPACE_DEPTH) {
          stack.push({ dir: entryPath, depth: depth + 1 })
        }
        continue
      }

      if (!entry.isFile()) continue
      if (totalChars >= MAX_WORKSPACE_CHARS) break

      try {
        const content = fs.readFileSync(entryPath, 'utf-8')
        const relativePath = path.relative(workspacePath, entryPath) || entry.name
        const parsed = parseMarkdownArtifact(content)
        const metadataLines = parsed.hasFrontmatter
          ? Object.entries(parsed.metadata)
            .filter(([key]) => ['artifact_type', 'agent', 'team', 'level', 'stage_type', 'status', 'verdict'].includes(key))
            .map(([key, value]) => `- ${key}: ${value}`)
            .join('\n')
          : ''
        const body = parsed.body
        const section = `## ${relativePath}\n\n` +
          (metadataLines ? `**Metadata**\n${metadataLines}\n\n` : '') +
          `${body.slice(0, 2000)}${body.length > 2000 ? '\n...(truncated)' : ''}`
        totalChars += section.length
        artifacts.push(section)
      } catch {
        // Skip unreadable files without discarding the rest of the workspace context.
      }
    }
  }

  return artifacts
}
