/**
 * Team Runtime — Discussion Tools (set_roster + create_brief)
 *
 * The two setup tools for the discussion engine: roster approval handshake
 * and assignment brief creation. Extracted from discussion.ts (S3-T10) to
 * keep that file under 500 lines.
 *
 * These tools run BEFORE `converse` and have no dependency on the round-running
 * machinery, making them a natural extraction boundary.
 */

import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Type } from 'typebox'
import { Text } from '@earendil-works/pi-tui'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { DiscussionContext } from './discussion.js'
import {
  getDiscussionState,
  getOrInitDiscussionState,
} from './discussion.js'
import type { ConversationMessage, DiscussionState } from '../core/types.js'
import { buildArtifactMetadata, writeMarkdownArtifact } from '../domains/runtime/artifacts.js'
import { publishAcceptedTeamChatMessage } from '../domains/runtime/team-chat-messages.js'
import { buildDiscussionRosterDispatchId } from '../core/discussion-continuation-control.js'

// ─── set_roster helpers ──────────────────────────────────────────────────────

/** Validate that all agent names exist in the configured participant list. */
function validateRosterAgents(agents: string[], participants: string[]): void {
  const invalid = agents.filter((name) => !participants.includes(name))
  if (invalid.length > 0) {
    throw new Error(
      `Invalid agent names: ${invalid.join(', ')}. ` +
      `Available participants: ${participants.join(', ')}`,
    )
  }
  if (agents.length === 0) {
    throw new Error('Roster cannot be empty. Provide at least one agent name.')
  }
}

/**
 * The rationale must describe exactly the roster that was locked.
 *
 * A selected agent with no reason, or a reason for an agent nobody selected,
 * both produce an announcement that misrepresents the choice: the first hides
 * why someone was convened, the second explains a name the run will never
 * dispatch. Neither is caught by counting entries.
 */
function validateRosterRationale(
  rationaleByAgent: Record<string, string>,
  roster: readonly string[],
): void {
  const missing = roster.filter((name) => !rationaleByAgent[name]?.trim())
  const unselected = Object.keys(rationaleByAgent).filter(
    (name) => !roster.includes(name),
  )
  if (missing.length === 0 && unselected.length === 0) return
  throw new Error(
    [
      'roster_rationale must give a reason for exactly the locked roster ' +
        `(${roster.join(', ')}).`,
      missing.length > 0 ? `Missing a reason for: ${missing.join(', ')}.` : '',
      unselected.length > 0
        ? `Not on the roster: ${unselected.join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  )
}

// ─── set_roster tool ─────────────────────────────────────────────────────────

/**
 * Create the `set_roster` tool for a discussion stage.
 * Must be called before `converse` to lock in the user-approved agent subset.
 */
export function createSetRosterTool(ctx: DiscussionContext) {
  return defineTool({
    name: 'set_roster',
    label: 'Set Agent Roster',
    description:
      `Lock the user-approved agent roster for this discussion. ` +
      `Call it only after the user has explicitly approved the selected participants.`,
    promptSnippet:
      `After the user explicitly approves the selected participants, call \`set_roster\` once with the approved names. ` +
      `\`converse\` will not work until the roster is locked.`,
    promptGuidelines: [],
    parameters: Type.Object({
      agents: Type.Array(Type.String(), {
        description: 'Array of approved agent names (must be a subset of the configured participants)',
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
      const { config } = ctx

      validateRosterAgents(params.agents, config.participants)

      const discussion = getOrInitDiscussionState(ctx)

      if (discussion.approvedRoster) {
        const sameApprovedRoster =
          discussion.approvedRoster.length === params.agents.length &&
          discussion.approvedRoster.every((name, idx) => name === params.agents[idx])

        if (sameApprovedRoster) {
          return {
            content: [{
              type: 'text' as const,
              text: `✅ Roster already locked: ${params.agents.join(', ')}. Call \`create_brief\` to formalize the engagement, then \`converse\`.`,
            }],
            details: undefined,
          }
        }

        throw new Error(
          `Roster is already locked as: ${discussion.approvedRoster.join(', ')}. ` +
          `Start a new discussion if you need a different roster.`
        )
      }

      discussion.approvedRoster = [...params.agents]
      delete discussion.pendingRoster
      delete discussion.pendingRosterRunId
      ctx.onRosterSelected?.(discussion.approvedRoster)

      return {
        content: [{
          type: 'text' as const,
          text: `✅ Roster locked: ${params.agents.join(', ')} (${params.agents.length} of ${config.participants.length} available agents). Now call \`create_brief\` to formalize the engagement, then \`converse\` to start the discussion.`,
        }],
        details: undefined,
      }
    },

    renderCall(args, theme) {
      const agents = (args as Record<string, unknown>).agents as string[] ?? []
      return new Text(`${theme.fg('accent', 'set_roster')} → ${agents.join(', ')}`)
    },

    renderResult(result, _options, theme) {
      const text = (result.content?.[0] as { text?: string })?.text ?? ''
      return new Text(theme.fg('success', text))
    },
  })
}

// ─── create_brief tool ───────────────────────────────────────────────────────

/** Build the markdown content for an Assignment Brief. */
function buildBriefContent(params: Record<string, unknown>, teamName: string, sessionId: string): string {
  const rosterRows = Object.entries(params.roster_rationale as Record<string, string>)
    .map(([name, rationale]) => `| ${name} | ${rationale} |`)
    .join('\n')

  const objectivesList = (params.objectives as string[])
    .map((obj, i) => `${i + 1}. ${obj}`)
    .join('\n')

  const deliverablesList = (params.deliverables as string[])
    .map((d) => `- ${d}`)
    .join('\n')

  const date = new Date().toISOString().split('T')[0]

  return (
    `# Assignment Brief\n\n` +
    `**Date:** ${date}\n` +
    `**Session:** ${sessionId}\n` +
    `**Team:** ${teamName}\n\n` +
    `## Client Inquiry\n\n` +
    `${params.inquiry}\n\n` +
    `## Objectives\n\n` +
    `${objectivesList}\n\n` +
    `## Scope\n\n` +
    `${params.scope}\n\n` +
    `## Out of Scope\n\n` +
    `${(params.out_of_scope as string | undefined) || 'Not specified.'}\n\n` +
    `## Team Roster\n\n` +
    `| Agent | Rationale |\n` +
    `|-------|-----------|\n` +
    `${rosterRows}\n\n` +
    `## Constraints\n\n` +
    `${(params.constraints as string | undefined) || 'None specified.'}\n\n` +
    `## Expected Deliverables\n\n` +
    `${deliverablesList}\n`
  )
}

/**
 * Tell the reader who was convened and why, before anyone is dispatched.
 *
 * Team chat picks a subset of the bench on the user's behalf, and the sidebar
 * then shows that subset as this run's participants. The choice is only
 * legible if the reasons arrive with it, so the announcement is a durable
 * message from the coordinator rather than tool output only the model sees.
 *
 * Ordered by the locked roster, not by the rationale map, so a replay renders
 * the same list in the same order.
 */
function announceRoster(
  ctx: DiscussionContext,
  discussion: DiscussionState,
  rationaleByAgent: Record<string, string>,
): void {
  const roster = discussion.approvedRoster ?? []
  const rosterLines = roster.map(
    (name) => `- **${name}** — ${rationaleByAgent[name]?.trim()}`,
  )
  const outcome = publishAcceptedTeamChatMessage(ctx, {
    agentName: ctx.config.coordinator || ctx.teamName,
    dispatchId: rosterDispatchId(ctx),
    messageType: 'framing',
    stageType: 'discussion',
    text: [
      `Convening ${roster.length} of ${ctx.config.participants.length} Team members for this message.`,
      '',
      ...rosterLines,
    ].join('\n'),
  })
  if (outcome === 'unrecordable' || outcome === 'disabled') return
  discussion.rosterAnnounced = true
}

/**
 * One announcement per discussion level.
 *
 * A recovery may use a new coordinator process after the announcement was
 * written but before its checkpoint. Keeping the identity independent of that
 * process lets the durable message boundary reconcile the same announcement.
 */
function rosterDispatchId(ctx: DiscussionContext): string {
  return buildDiscussionRosterDispatchId(
    ctx.levelId,
    ctx.state.levelStates.get(ctx.levelId)?.visitCount ?? 0,
  )
}

/**
 * Create the `create_brief` tool for a discussion stage.
 * Synthesizes the conversation into a formal Assignment Brief (SOW) markdown file.
 */
export function createBriefTool(ctx: DiscussionContext) {
  return defineTool({
    name: 'create_brief',
    label: 'Create Assignment Brief',
    description: ctx.chatMode
      ? `Synthesize the conversation into in-memory context for the selected Team members. ` +
        `Do not create a deliverable file. Must be called after \`set_roster\` and before \`converse\`.`
      : `Synthesize the conversation with the user into a formal Assignment Brief (Statement of Work). ` +
        `Captures the client's inquiry, objectives, scope, team roster with rationale, constraints, and expected deliverables. ` +
        `Must be called after \`set_roster\` locks the roster and before \`converse\`.`,
    promptSnippet: ctx.chatMode
      ? `After locking the roster with \`set_roster\`, call \`create_brief\` to prepare the Team chat context in memory. ` +
        `\`roster_rationale\` must carry one non-empty reason for every agent you locked and for no one else; the user is shown those reasons before the specialists answer. ` +
        `Do not create or promise a file unless the user explicitly requests one.`
      : `After locking the roster with \`set_roster\`, call \`create_brief\` to create a formal assignment brief. ` +
        `Synthesize everything the user told you: their problem, objectives, scope, why each agent was selected, and expected deliverables. ` +
        `This is a formal Statement of Work — write it as if a consulting firm is documenting a client engagement.`,
    promptGuidelines: [],
    parameters: Type.Object({
      title: Type.String({ description: 'Brief title — a concise name for this engagement' }),
      inquiry: Type.String({ description: "The client's original problem/inquiry, synthesized from the conversation" }),
      objectives: Type.Array(Type.String(), { description: 'Key objectives for this engagement' }),
      scope: Type.String({ description: 'What this engagement covers' }),
      out_of_scope: Type.Optional(Type.String({ description: 'What is explicitly excluded' })),
      roster_rationale: Type.Record(Type.String(), Type.String(), { description: 'Map of agent name → why this agent was selected. One entry for every locked agent and no one else.' }),
      constraints: Type.Optional(Type.String({ description: 'Time, budget, or other constraints noted by the client' })),
      deliverables: Type.Array(Type.String(), { description: 'Expected outputs/deliverables from this engagement' }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
      const { state, outputPath } = ctx

      // Check that roster is locked
      const discussion = getDiscussionState(ctx)
      if (!discussion?.approvedRoster) {
        throw new Error('Roster must be locked via set_roster before creating the assignment brief.')
      }

      validateRosterRationale(
        params.roster_rationale as Record<string, string>,
        discussion.approvedRoster,
      )

      const objectiveCount = (params.objectives as string[]).length
      const deliverableCount = (params.deliverables as string[]).length
      const rosterCount = Object.keys(params.roster_rationale as Record<string, string>).length

      if (ctx.chatMode) {
        announceRoster(ctx, discussion, params.roster_rationale as Record<string, string>)
        return {
          content: [{
            type: 'text' as const,
            text:
              `✅ Chat context prepared: "${params.title}"\n\n` +
              `**Summary:**\n` +
              `- ${objectiveCount} objective(s)\n` +
              `- ${rosterCount} agent(s) on roster\n` +
              `- ${deliverableCount} requested response(s)\n\n` +
              `You may now call \`converse\` to start the discussion.`,
          }],
          details: undefined,
        }
      }

      const briefContent = buildBriefContent(params, ctx.teamName, state.sessionId)

      // Workflow discussions persist their formal assignment brief.
      const briefPath = path.join(outputPath, 'brief.md')
      writeMarkdownArtifact(
        briefPath,
        briefContent,
        buildArtifactMetadata({
          filePath: briefPath,
          rootDir: outputPath,
          artifactType: 'brief',
          sessionId: state.sessionId,
          ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
          ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
          team: ctx.teamName,
          level: ctx.levelId,
          stageType: 'discussion',
          status: 'locked',
          title: params.title as string,
        }),
      )

      return {
        content: [{
          type: 'text' as const,
          text:
            `✅ Assignment Brief created: "${params.title}"\n\n` +
            `📄 Saved to: ${briefPath}\n\n` +
            `**Summary:**\n` +
            `- ${objectiveCount} objective(s)\n` +
            `- ${rosterCount} agent(s) on roster\n` +
            `- ${deliverableCount} expected deliverable(s)\n\n` +
            `You may now call \`converse\` to start the discussion.`,
        }],
        details: undefined,
      }
    },

    renderCall(args, theme) {
      const title = args.title
      return new Text(`${theme.fg('accent', 'create_brief')} → ${title}`)
    },

    renderResult(result, _options, theme) {
      const firstContent = result.content?.[0]
      const text = firstContent?.type === 'text' ? firstContent.text : ''
      const firstLine = text.split('\n')[0] ?? ''
      return new Text(theme.fg('success', firstLine))
    },
  })
}
