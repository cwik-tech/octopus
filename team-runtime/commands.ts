/**
 * Team Runtime — CLI Command Registrations
 *
 * All pi.registerCommand(...) handlers extracted from index.ts.
 * Accepts `ctx: RuntimeContext` for access to all runtime state.
 */

import * as path from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { LEVEL_STATUS, AGENT_STATE, MAX_NOTIFY_LENGTH } from '../core/constants.js'
import { formatCost, formatElapsedMs } from '../core/constraints.js'
import { generateMinutes } from '../domains/agent-execution/minutes.js'
import { getAssignmentPath } from '../domains/runtime/runtime-paths.js'
import { buildStageEntryFollowUp } from '../domains/stage/stage-entry.js'
import type { LevelConfig } from '../core/types.js'
import type { RuntimeContext } from '../domains/runtime/runtime-context.js'
import { updateDashboard } from './dashboard.js'
import {
  discardPendingStageEntries,
  enqueueFollowUp,
} from '../domains/runtime/follow-up.js'
import { resolveEntryLevelIndex } from '../core/stage-helpers.js'
import { TEAM_HOST_RUN_COMMAND_NAME } from '../core/pi-runtime.js'
import type { HostRunStop } from '../domains/runtime/host-run-lifetime.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getElapsedMs(ctx: RuntimeContext): number {
  if (!ctx.state.timerStarted) return 0
  const end = ctx.state.endTime ?? Date.now()
  return end - ctx.state.startTime
}

// ─── Command Registration ────────────────────────────────────────────────────

/**
 * Register the runtime's slash commands.
 *
 * @param ctx The runtime this session owns.
 * @param registerLevelTools Arm the active level's governed stage tools.
 * @param persistState Write the runtime state to session storage and the
 *   crash-recovery checkpoint.
 * @param runtimeOwnsLevel Whether the runtime, rather than a coordinator,
 *   drives a level. The same policy the gate-driven advance is given, passed in
 *   rather than read here, so no two transitions can answer it differently.
 * @param prepareHostForActiveLevel Put the host on the newly active level's
 *   pair and arm its stage, unless a turn still owns the loop — in which case
 *   that turn's `agent_settled` does it. Returns false when the host could not
 *   be prepared, and then nothing may be sent to it.
 * @param startActiveLevel Start a runtime-owned stage directly. Absent when the
 *   caller has no autostart path.
 * @param reportHostRunStop What the host did when it stopped, so a stop that is
 *   a failure is recorded as one. Absent for a runtime that owns no process.
 * @param admitHostEntryForActiveLevel Record that the newly active level is
 *   owed an opening entry, on the pair it resolves to now. Called immediately
 *   before `persistState` so the destination and that record reach the disk
 *   together. Absent for a runtime that keeps no durable state.
 */
export function registerCommands(
  ctx: RuntimeContext,
  registerLevelTools: () => void,
  persistState: () => void,
  runtimeOwnsLevel: (level: LevelConfig) => boolean,
  prepareHostForActiveLevel: (extCtx: ExtensionContext) => Promise<boolean>,
  startActiveLevel?: (extCtx: ExtensionContext) => Promise<boolean>,
  reportHostRunStop?: (stop: HostRunStop) => void,
  admitHostEntryForActiveLevel?: () => void,
): void {
  // ── team-host-run ────────────────────────────────────────────────────────

  /**
   * The command a launched Team host is started with, and the whole reason its
   * process stays alive.
   *
   * Pi's print mode awaits its prompts and then disposes the session
   * (`@earendil-works/pi-coding-agent/dist/modes/print-mode.js:105`, `:134`).
   * A Team run has no single prompt to give it: the opening entry is queued at
   * startup rather than prompted, and every later level is entered by another
   * entry queued while the previous turn settles. So the host is launched with
   * this instead. Pi executes a slash command before it consults `input` and
   * without sending anything to a model (`dist/core/agent-session.js:803`),
   * and it awaits the handler — so returning only when nothing is owed is what
   * keeps the process alive for exactly as long as the run needs it.
   *
   * Nothing is dispatched from here. The runtime's existing queue and its
   * settle handler still decide what is sent and when; this only decides when
   * the process may end.
   */
  ctx.pi.registerCommand(TEAM_HOST_RUN_COMMAND_NAME, {
    description: 'Hold this host open until the run has no work left',
    async handler() {
      const lifetime = ctx.hostRunLifetime
      if (!lifetime) return
      // Asked once before waiting: a host whose configuration failed, or which
      // was given nothing to do, has no entry coming and must not wait for one.
      lifetime.reconsider()
      // Then held, because waiting is not work. Everything the run is waiting
      // for arrives on an unreferenced timer, so without this the process ends
      // here with its opening entry still queued.
      lifetime.hold()
      // Why it stopped matters, and is not the same question as whether it
      // stopped. A host that ran out of work finished; a host whose entry never
      // took a turn did not, and returning quietly would leave that recorded as
      // an ordinary incomplete run rather than as a run that cannot proceed.
      reportHostRunStop?.(await lifetime.whenStopped())
    },
  })

  // ── team-status ──────────────────────────────────────────────────────────

  ctx.pi.registerCommand('team-status', {
    description: 'Show current team status, level, and agent states',
    async handler(_args, extCtx) {
      if (!ctx.teamConfig) {
        extCtx.ui.notify('No team loaded.', 'warning')
        return
      }

      const level = ctx.teamConfig.levels[ctx.state.currentLevelIndex]
      const lines = [
        `**Team:** ${ctx.teamConfig.team.name}`,
        `**Level:** ${level?.name || 'none'} (${level?.stage.type || 'none'})`,
        `**Cost:** ${formatCost(ctx.state.totalCost)}`,
        `**Elapsed:** ${formatElapsedMs(getElapsedMs(ctx))}`,
        '',
        '**Levels:**',
      ]

      for (const l of ctx.teamConfig.levels) {
        const ls = ctx.state.levelStates.get(l.id)
        const icon = ls?.status === LEVEL_STATUS.COMPLETED ? '\u2713' : ls?.status === LEVEL_STATUS.ACTIVE ? '\u25c9' : '\u25cb'
        lines.push(`  ${icon} ${l.name} (${l.stage.type}) \u2014 ${ls?.status || 'unknown'}`)
      }

      lines.push('', '**Agents:**')
      for (const [name, metrics] of ctx.agentMetrics) {
        lines.push(`  ${name}: ${metrics.state} (r:${metrics.rounds}, $${metrics.totalCost.toFixed(2)})`)
      }

      extCtx.ui.notify(lines.join('\n'), 'info')
    },
  })

  // ── team-advance ─────────────────────────────────────────────────────────

  ctx.pi.registerCommand('team-advance', {
    description: 'Manually advance to the next level (bypass gate)',
    async handler(_args, extCtx: ExtensionContext) {
      if (!ctx.teamConfig) return

      const currentLevel = ctx.teamConfig.levels[ctx.state.currentLevelIndex]
      if (!currentLevel) return

      const nextIdx = ctx.state.currentLevelIndex + 1
      if (nextIdx >= ctx.teamConfig.levels.length) {
        extCtx.ui.notify('Already at the final level.', 'warning')
        return
      }
      const newLevel = ctx.teamConfig.levels[nextIdx]
      if (!newLevel) return

      const confirmed = await extCtx.ui.confirm(
        'Advance level?',
        `Skip gate and advance from "${currentLevel.name}" to "${newLevel.name}"?`,
      )
      if (!confirmed) return

      const currentLevelState = ctx.state.levelStates.get(currentLevel.id)
      if (currentLevelState) currentLevelState.status = LEVEL_STATUS.COMPLETED

      ctx.state.currentLevelIndex = nextIdx
      const newLevelState = ctx.state.levelStates.get(newLevel.id)
      if (newLevelState) newLevelState.status = LEVEL_STATUS.ACTIVE

      // Skipping the gate is the only thing this command is meant to skip.
      // Arming the destination is a separate act, and the turn that will enter
      // it has not started — the previous coordinator may still own the outer
      // turn. Registering its tools here would put them in front of that
      // coordinator, on its pair, and starting the stage would run it under a
      // turn nobody opened for it.
      ctx.pendingStageEntryLevelId = null
      const runtimeOwnsDestination = runtimeOwnsLevel(newLevel)
      if (runtimeOwnsDestination) registerLevelTools()
      updateDashboard(extCtx, ctx)
      // With the destination, not after it: a checkpoint that named this level
      // without the record of the entry about to enter it is the window a
      // restart replays blindly.
      admitHostEntryForActiveLevel?.()
      persistState()
      const startedByRuntime = runtimeOwnsDestination
        ? (await startActiveLevel?.(extCtx) ?? false)
        : false
      if (startedByRuntime) {
        ctx.pendingStageEntryLevelId = null
      } else {
        ctx.pendingStageEntryLevelId = newLevel.id
        // Pi runs a command immediately, streaming or idle. When nothing is
        // streaming there is no `agent_settled` coming, so this advance is the
        // only thing that can put the host on the new level's pair and arm its
        // stage before its entry goes out.
        const prepared = await prepareHostForActiveLevel(extCtx)
        if (!prepared) return
        enqueueFollowUp(ctx, buildStageEntryFollowUp(newLevel), {
          kind: 'stage_entry',
          levelId: newLevel.id,
          stageType: newLevel.stage.type,
        })
      }

      extCtx.ui.notify(`Advanced to: ${newLevel.name}`, 'info')
    },
  })

  // ── team-reset ───────────────────────────────────────────────────────────

  ctx.pi.registerCommand('team-reset', {
    description: 'Reset team to its entry level',
    async handler(_args, extCtx: ExtensionContext) {
      if (!ctx.teamConfig) return

      const confirmed = await extCtx.ui.confirm('Reset team?', 'This will reset all level states to the beginning.')
      if (!confirmed) return

      const entryLevelIndex = resolveEntryLevelIndex(
        ctx.teamConfig.levels,
        ctx.teamConfig.workflow?.entry_level,
      )
      const entryLevel = ctx.teamConfig.levels[entryLevelIndex]
      ctx.state.currentLevelIndex = entryLevelIndex
      ctx.state.totalCost = 0
      ctx.state.startTime = 0
      ctx.state.timerStarted = false
      ctx.state.endTime = null

      for (const [id, ls] of ctx.state.levelStates) {
        ls.status = id === entryLevel?.id ? LEVEL_STATUS.ACTIVE : LEVEL_STATUS.PENDING
        ls.stageStatus = id === entryLevel?.id ? 'ready' : 'not_started'
        ls.engineState = null
        ls.loopbackCount = 0
      }

      for (const [, metrics] of ctx.agentMetrics) {
        metrics.state = AGENT_STATE.IDLE
        metrics.rounds = 0
        metrics.totalCost = 0
        metrics.contextTokens = 0
        delete metrics.activeStartedAt
      }

      // Everything queued for the level the run is leaving is now addressed to
      // a stage that will not happen. Dropped with its timer, so nothing can
      // wake later and open a level this reset has just undone.
      discardPendingStageEntries(ctx, 'team_reset')

      // A reset is a transition, and it owes the level it lands on exactly what
      // an advance owes the level it moves to: switch the host to that level's
      // pair, arm that level's stage, then send its entry — and none of it
      // while a turn still owns the host loop. Arming here, before any of that,
      // would put the entry level's tools in front of whoever is still running.
      ctx.pendingStageEntryLevelId = null
      const runtimeOwnsEntry = entryLevel ? runtimeOwnsLevel(entryLevel) : false
      if (runtimeOwnsEntry) registerLevelTools()
      updateDashboard(extCtx, ctx)
      // The admission this reset is leaving was dropped above, with the queued
      // entries it belonged to. This one is for the level the reset lands on.
      if (entryLevel) admitHostEntryForActiveLevel?.()
      persistState()
      if (entryLevel) {
        const startedByRuntime = runtimeOwnsEntry
          ? (await startActiveLevel?.(extCtx) ?? false)
          : false
        if (startedByRuntime) {
          ctx.pendingStageEntryLevelId = null
        } else {
          ctx.pendingStageEntryLevelId = entryLevel.id
          const prepared = await prepareHostForActiveLevel(extCtx)
          // Fail closed. An entry sent to a host that could not be put on the
          // entry level's pair runs that level on whatever pair the run had
          // left, and saying the reset completed would make that invisible.
          if (!prepared) return
          enqueueFollowUp(ctx, buildStageEntryFollowUp(entryLevel), {
            kind: 'stage_entry',
            levelId: entryLevel.id,
            stageType: entryLevel.stage.type,
          })
        }
      }

      extCtx.ui.notify('Team reset to entry level.', 'info')
    },
  })

  // ── team-minutes ─────────────────────────────────────────────────────────

  ctx.pi.registerCommand('team-minutes', {
    description: 'Generate meeting minutes — concise LLM-summarized overview of all agent interactions',
    async handler(_args, extCtx: ExtensionContext) {
      if (!ctx.teamConfig) {
        extCtx.ui.notify('No team loaded.', 'warning')
        return
      }

      let hasData = false
      for (const [, ls] of ctx.state.levelStates) {
        if (ls.engineState !== null) {
          hasData = true
          break
        }
      }

      if (!hasData) {
        extCtx.ui.notify('No conversation data yet. Run at least one round first.', 'warning')
        return
      }

      const outputDir = getAssignmentPath(ctx)

      extCtx.ui.notify('Generating meeting minutes...', 'info')

      const minutes = await generateMinutes(
        ctx.teamConfig,
        ctx.state,
        outputDir,
        ctx.shutdownController.signal,
      )

      if (!minutes) {
        extCtx.ui.notify('No conversation data to summarize.', 'warning')
        return
      }

      if (minutes.length <= MAX_NOTIFY_LENGTH) {
        extCtx.ui.notify(minutes, 'info')
      } else {
        const minutesPath = path.join(outputDir, 'minutes.md')
        extCtx.ui.notify(
          `Meeting minutes generated (${minutes.length} chars).\n\nSaved to: ${minutesPath}\n\n` +
          minutes.slice(0, MAX_NOTIFY_LENGTH) + '\n\n... (truncated, see full file)',
          'info',
        )
      }
    },
  })
}
