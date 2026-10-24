/**
 * Team Runtime — Experience Reflections
 *
 * After a level completes, each participating agent reflects on the session
 * and appends an entry to their experience scratch pad.
 *
 * Extracted from level-lifecycle.ts (S3-T10) to keep that file under 500 lines.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  LevelConfig,
  DiscussionState,
  BroadcastState,
  LoadedAgent,
} from '../core/types.js'
import { STAGE_TYPE, DEFAULT_AUXILIARY_LLM_TIMEOUT_MINUTES } from '../core/constants.js'
import { roundUsd } from '../core/budget-ledger.js'
import { runAgent } from '../domains/agent-execution/agent-runner.js'
import { toModelSelectionRecord } from '../contracts/agent-model-selection.js'
import { logAgentRun } from '../domains/runtime/logger.js'
import { whenDefined } from '../core/optional-properties.js'
import {
  buildDiscussionHistory,
} from '../engines/discussion.js'
import {
  buildBroadcastHistory,
} from '../engines/broadcast.js'
import type { RuntimeContext } from '../domains/runtime/runtime-context.js'
import { readMarkdownArtifact } from '../domains/runtime/artifacts.js'

// ── Reflection Context ───────────────────────────────────────────────────────

/** Determines which agents participated and extracts session history. */
function buildReflectionContext(
  level: LevelConfig,
  ctx: RuntimeContext,
): { participantNames: string[]; sessionHistory: string } | null {
  const engineState = ctx.state.levelStates.get(level.id)?.engineState ?? null
  if (!engineState) return null

  const stage = level.stage
  switch (stage.type) {
    case STAGE_TYPE.DISCUSSION: {
      if (engineState.type !== STAGE_TYPE.DISCUSSION) return null
      const approvedRoster = engineState.approvedRoster || stage.participants
      return {
        participantNames: [stage.coordinator, ...approvedRoster],
        sessionHistory: buildDiscussionHistory(engineState),
      }
    }
    case STAGE_TYPE.BROADCAST: {
      if (engineState.type !== STAGE_TYPE.BROADCAST) return null
      const participants = stage.coordinator
        ? [stage.coordinator, ...stage.fan_out]
        : [...stage.fan_out]
      return {
        participantNames: participants,
        sessionHistory: buildBroadcastHistory(engineState),
      }
    }
    default:
      return null // Chain, review, pipeline — not yet implemented
  }
}

// ── Prompt Builders ──────────────────────────────────────────────────────────

/** Build the substituted system prompt for one agent's reflection run. */
function buildAgentSystemPrompt(
  agent: LoadedAgent,
  sessionId: string,
  teamName: string,
  workspacePath: string,
): string {
  let prompt = agent.systemPrompt
  prompt = prompt.replaceAll('{{SESSION_ID}}', sessionId)
  prompt = prompt.replaceAll('{{TEAM_NAME}}', teamName)
  prompt = prompt.replaceAll('{{WORKSPACE_PATH}}', workspacePath)
  prompt = prompt.replaceAll('{{EXPERIENCE_PATH}}', agent.experienceEnabled ? path.join(agent.agentDir, 'experience') : '')
  return prompt
}

/** Build the user message instructing an agent to write a scratch-pad entry. */
function buildReflectionUserMessage(
  agent: LoadedAgent,
  brief: string,
  sessionHistory: string,
  date: string,
): string {
  const scratchPadPath = path.join(agent.agentDir, 'experience', 'scratch-pad.md')
  return (
    `# Session Reflection\n\n` +
    `## Original Brief\n\n${brief}\n\n` +
    `## Full Session History\n\n${sessionHistory}\n\n` +
    `## Task\n\n` +
    `Reflect on this completed session. Append a SINGLE new entry to your experience scratch pad ` +
    `at \`${scratchPadPath}\`.\n\n` +
    `Use this format:\n\n` +
    `### Session: ${date} — [brief topic description]\n` +
    `- **What worked:** [approaches/methods that produced good results]\n` +
    `- **What didn't:** [approaches that failed or produced weak results]\n` +
    `- **Pattern noticed:** [any recurring pattern worth remembering]\n` +
    `- **For next time:** [specific adjustment to try in future sessions]\n\n` +
    `Read the file first to see existing entries, then append your new entry at the end. ` +
    `Do not overwrite existing content.`
  )
}

// ── Agent Spawning ───────────────────────────────────────────────────────────

/** Spawn all reflection agents in parallel, swallowing individual errors. */
async function spawnReflectionAgents(
  uniqueAgents: string[],
  ctx: RuntimeContext,
  brief: string,
  sessionHistory: string,
  date: string,
  assignmentPath: string,
): Promise<void> {
  // Read once rather than asserted at each use. This function already runs only
  // where a team is loaded, and repeating `!` at every field would spread an
  // assumption this can state in one place.
  const teamConfig = ctx.teamConfig
  if (!teamConfig) return

  /**
   * Records one lifecycle event, and never becomes the phase's problem.
   *
   * The pre-send record is different and stays strict: refusing to dispatch a
   * model nothing can account for is the point. Afterwards the model has run
   * and the Agent has written its entry, so a journal that breaks in between
   * must not reject a best-effort phase — that would stop the level over a
   * logging fault, which is what `Promise.all` below would do with a throw.
   */
  const recordTerminal = (event: Parameters<typeof logAgentRun>[1]): void => {
    try {
      logAgentRun(assignmentPath, event)
    } catch {
      // Not silent. The phase carries on, but a lifecycle record that could not
      // be written is a fact somebody has to be able to find — reported on the
      // process boundary, because the journal that would normally hold it is
      // the thing that just failed.
      //
      // Structured, and identity only. The raw error is deliberately dropped:
      // its message carries filesystem paths, and a fixed category says
      // everything a reader needs — the write failed, on this event, for this
      // Agent, in this session.
      console.error(JSON.stringify({
        event: 'runtime.agent_run_record_write_failed',
        error: 'record_write_failed',
        lifecycle: event.event,
        agent_name: event.agent_name,
        session_id: event.session_id,
      }))
    }
  }

  const promises = uniqueAgents.map(async (agentName) => {
    const agent = ctx.agents.get(agentName)
    if (!agent) return
    if (!agent.experienceEnabled) return
    // Nothing is asked, and nothing is recorded, for a session nobody is
    // waiting for — and the caller still hears about it. This phase rejected on
    // an aborted signal before, because the dispatch threw and the handler
    // rethrew; swallowing that would turn an interrupted shutdown into a silent
    // success.
    if (ctx.shutdownController.signal.aborted) {
      throw new Error(`Experience reflection for '${agentName}' was cancelled.`)
    }
    // No pair anybody chose is no pair to run on. An Agent whose selection
    // could not be resolved has empty provider and model, so dispatching would
    // ask a question nothing can answer and record a model that does not exist.
    const selection = agent.selection
    if (!selection) return

    const systemPrompt = buildAgentSystemPrompt(
      agent,
      ctx.state.sessionId,
      teamConfig.team.name,
      teamConfig.workspace.path,
    )
    const userMessage = buildReflectionUserMessage(agent, brief, sessionHistory, date)

    const startedAt = Date.now()
    const runEvent = {
      session_id: ctx.state.sessionId,
      ...whenDefined(ctx.state.rootSessionId, (root_session_id) => ({
        root_session_id,
      })),
      assignment_path: assignmentPath,
      team: teamConfig.team.name,
      agent_name: agentName,
      agent_type: 'agent' as const,
      // What caused this dispatch, on the field that already means that. The
      // same Agent has already run once this level on the same pair, so a
      // record that did not say which of the two this was would leave a person
      // unable to attribute either model use to the work it did.
      trigger_tool: 'experience_reflection',
      model: selection.model,
      provider: selection.provider,
    }
    // Written before the send, and a record that cannot be written means the
    // model is not used. A reflection is optional work; running it with no
    // account of which model wrote into an Agent's own experience file is not
    // a trade this makes.
    try {
      logAgentRun(assignmentPath, {
        timestamp: new Date(startedAt).toISOString(),
        event: 'start',
        ...runEvent,
        model_selection: toModelSelectionRecord(selection, 'agent'),
      })
    } catch {
      return
    }

    try {
      const result = await runAgent({
        systemPrompt,
        userMessage,
        model: selection.model,
        thinking: agent.thinking,
        cwd: teamConfig.workspace.path,
        provider: selection.provider,
        // The assignment and session, so this call is no longer invisible to
        // the run's own provider telemetry.
        //
        // Deliberately *not* `agentName`. A dispatch carrying an agent identity
        // is routed through the parent's worker/tool loop when one is injected
        // (`mcp-worker-turn-client.ts:146`), and that comment says why:
        // internal runtime calls have no agent identity and continue through
        // their normal provider. Naming this one there would move a reflection
        // onto another route; the name belongs on the record above.
        outputPath: assignmentPath,
        sessionId: ctx.state.sessionId,
        ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({
          rootSessionId,
        })),
        timeoutMinutes: DEFAULT_AUXILIARY_LLM_TIMEOUT_MINUTES,
        signal: ctx.shutdownController.signal,
      })
      ctx.state.totalCost = roundUsd(ctx.state.totalCost + (result.cost ?? 0))
      recordTerminal({
        timestamp: new Date().toISOString(),
        event: 'end',
        ...runEvent,
        duration_ms: Date.now() - startedAt,
      })
    } catch (err) {
      // Every start gets a terminal record, cancellation included, so no
      // reflection is left looking like it is still running — but a journal
      // that cannot take it does not become this phase's failure, and never
      // replaces the reason the dispatch actually gave.
      recordTerminal({
        timestamp: new Date().toISOString(),
        event: 'fail',
        ...runEvent,
        duration_ms: Date.now() - startedAt,
        status: err instanceof Error ? err.message : String(err),
      })
      if (ctx.shutdownController.signal.aborted) throw err
      console.error(
        `[team-runtime] Experience reflection failed for ${agentName}:`,
        err instanceof Error ? err.message : err,
      )
    }
  })

  await Promise.all(promises)
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Spawn each involved agent one final time to reflect on the session
 * and append an entry to their experience scratch pad.
 */
export async function runExperienceReflections(
  level: LevelConfig,
  ctx: RuntimeContext,
  assignmentPath: string,
): Promise<void> {
  const context = buildReflectionContext(level, ctx)
  if (!context) return

  const { participantNames, sessionHistory } = context

  if (
    sessionHistory.trim() === '' ||
    sessionHistory.includes('No conversation recorded') ||
    sessionHistory.includes('No responses recorded')
  ) {
    return
  }

  const uniqueAgents = [...new Set(participantNames)]

  const briefPath = path.join(assignmentPath, 'brief.md')
  const brief = fs.existsSync(briefPath)
    ? readMarkdownArtifact(briefPath).body
    : '_No brief recorded._'

  const date = new Date().toISOString().slice(0, 10)

  await spawnReflectionAgents(
    uniqueAgents,
    ctx,
    brief,
    sessionHistory,
    date,
    assignmentPath,
  )
}
