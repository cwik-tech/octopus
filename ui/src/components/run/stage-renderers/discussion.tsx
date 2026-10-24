import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { ArtifactPreviewTarget, RunEvent, StageRendererProps } from './index'
import { isDisplayable } from './event-model'
import {
  describeModelSelection,
  isHelperModelSelection,
  type ModelSelectionRecord,
} from '@contracts/agent-model-selection'
import { AgentIdentityAvatar } from '@/components/run/shared/agent-identity'
import { ProviderModelIcon } from '@/components/ui/provider-model-icon'
import { getApiBaseUrl } from '@/lib/utils/desktop'
import { formatTimestamp } from '@/lib/models/runtime-model'
import { formatDisplayName } from '@/lib/utils/display-name'
import { Button } from "@/components/ui/button";

// ── Constants ─────────────────────────────────────────────────────────────

const API_BASE = getApiBaseUrl()

/**
 * Static 6-colour fallback palette used when GET /api/team is unavailable.
 * Values are CSS hex strings compatible with Tailwind's colour ramp.
 */
const FALLBACK_PALETTE: readonly [string, ...string[]] = [
  '#6366f1', // indigo-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#f97316', // orange-500
  '#10b981', // emerald-500
  '#06b6d4', // cyan-500
]

// ── Types ─────────────────────────────────────────────────────────────────

interface MessageGroup {
  /** Stable identifier for the agent (falls back to agentName or 'system'). */
  agentId: string
  /**
   * The concrete attempt these messages belong to.
   *
   * Part of the grouping key so two attempts by one agent stay two bubbles
   * with two labels. Absent for runs recorded before dispatch ids existed.
   */
  dispatchId?: string
  /** Display name shown above the message group. */
  agentName: string
  /** Runtime provider used by the agent for this group. */
  provider: string | undefined
  /** Runtime model used by the agent for this group. */
  model: string | undefined
  /**
   * How this agent's pair was decided, as the run recorded it.
   *
   * Read from `agent.start`, which carries no content and so is not itself
   * displayable — the selection has to be collected from every event, not
   * only the ones that produce a bubble.
   */
  modelSelection: ModelSelectionRecord | undefined
  /** stageName at the time this group started (for separator logic). */
  stageName: string | undefined
  /** All displayable events in this group. */
  events: RunEvent[]
}

type TeamAgent = { id: string; name: string; color?: string }

// ── Group builder ─────────────────────────────────────────────────────────

/**
 * Groups consecutive displayable events by (agentId, stageName).
 * A new group is started whenever the agent or stage name changes.
 */
function buildGroups(events: RunEvent[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  // Collected across every event, because the event that records the selection
  // is the one that starts the agent and shows nothing.
  //
  // Keyed by the attempt, not by the agent. One agent can speak twice in a run
  // on different models — an approved retry on the application default is
  // exactly that — and keeping the first selection per agent would put the
  // first attempt's label on the second, hiding the notice the retry exists
  // for. Runs recorded before dispatch ids fall back to the agent, where the
  // agent-wide answer is the only one there is.
  const selectionByDispatch = new Map<string, ModelSelectionRecord>()
  const selectionByAgent = new Map<string, ModelSelectionRecord>()
  for (const event of events) {
    if (!event.modelSelection) continue
    // A helper's own selection is not a participant's. Naming a delegated job,
    // compressing a discussion and writing its minutes are all the
    // application's own work, disclosed as their own notices in the
    // conversation — and each carries a runtime id that `toRunEvent` also falls
    // back to for `agentId`, so taking one here would label whichever member
    // shared that id with a model it never ran on.
    if (isHelperModelSelection(event.modelSelection.caller)) continue
    if (event.dispatchId && !selectionByDispatch.has(event.dispatchId)) {
      selectionByDispatch.set(event.dispatchId, event.modelSelection)
    }
    const key = event.agentId ?? event.agentName ?? "system"
    if (!selectionByAgent.has(key)) selectionByAgent.set(key, event.modelSelection)
  }
  const selectionFor = (event: RunEvent, agentId: string) =>
    event.dispatchId
      ? selectionByDispatch.get(event.dispatchId)
      : selectionByAgent.get(agentId)

  for (const event of events) {
    if (!isDisplayable(event)) continue

    const agentId = event.agentId ?? event.agentName ?? 'system'
    const agentName = event.agentName ?? event.agentId ?? 'System'
    const last = groups[groups.length - 1]

    if (
      last &&
      last.agentId === agentId &&
      last.stageName === event.stageName &&
      // Two attempts by one agent are two bubbles. Merging them would put one
      // attempt's model on the other's words.
      last.dispatchId === event.dispatchId
    ) {
      last.events.push(event)
      last.model ??= event.model
      last.provider ??= event.provider
      last.modelSelection ??= selectionFor(event, agentId)
    } else {
      groups.push({
        agentId,
        agentName,
        model: event.model,
        provider: event.provider,
        modelSelection: selectionFor(event, agentId),
        stageName: event.stageName,
        ...(event.dispatchId ? { dispatchId: event.dispatchId } : {}),
        events: [event],
      })
    }
  }

  return groups
}

// ── Sub-components ────────────────────────────────────────────────────────

function StageSeparator({ stageName }: { stageName: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border/60" />
      <span className="rounded-full border border-border/60 bg-muted/60 px-3 py-0.5 text-xs font-medium text-muted-foreground">
        {formatDisplayName(stageName)}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  )
}

function getArtifactTarget(event: RunEvent, fallbackRunId: string | undefined): ArtifactPreviewTarget | null {
  if (!event.artifactPath) return null
  const runId = event.artifactRunId ?? event.runId ?? fallbackRunId
  if (!runId) return null
  return {
    artifactPath: event.artifactPath,
    runId,
  }
}

function ArtifactMessage({
  event,
  fallbackRunId,
  label,
  onOpenArtifact,
  tone,
}: {
  event: RunEvent
  fallbackRunId?: string | undefined
  label: 'Artifact:' | 'Delivery:'
  onOpenArtifact?: ((target: ArtifactPreviewTarget) => void) | undefined
  tone: 'default' | 'delivery'
}) {
  const target = getArtifactTarget(event, fallbackRunId)
  const className = [
    'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
    tone === 'delivery'
      ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-700 hover:bg-emerald-500/12 dark:text-emerald-400'
      : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/70',
    target ? 'cursor-pointer' : 'cursor-default',
  ].join(' ')

  return (
    <Button
      variant="ghost"
      size="xs"
      className={className}
      disabled={!target}
      onClick={() => {
        if (target) onOpenArtifact?.(target)
      }}
    >
      <span className={tone === 'delivery' ? 'font-medium' : 'font-medium text-foreground'}>
        {label}
      </span>
      <span className="font-mono">{event.artifactPath ?? 'output'}</span>
    </Button>
  )
}

function EventTimestamp({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp)
  const isValid = Number.isFinite(date.getTime())
  const dateTime = isValid ? date.toISOString() : undefined
  const label = formatTimestamp(dateTime)

  return (
    <time
      aria-label={`Event timestamp: ${label}`}
      className="shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted-foreground whitespace-nowrap"
      dateTime={dateTime}
    >
      {label}
    </time>
  )
}

function EventRow({ children, event }: { children: ReactNode; event: RunEvent }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0 flex-1">{children}</div>
      <EventTimestamp timestamp={event.ts} />
    </div>
  )
}

function EventMessage({
  event,
  fallbackRunId,
  onOpenArtifact,
}: {
  event: RunEvent
  fallbackRunId?: string | undefined
  onOpenArtifact?: ((target: ArtifactPreviewTarget) => void) | undefined
}) {
  let content: ReactNode | null = null

  if (event.type === 'artifact.written') {
    content = (
      <ArtifactMessage
        event={event}
        fallbackRunId={fallbackRunId}
        label="Artifact:"
        onOpenArtifact={onOpenArtifact}
        tone="default"
      />
    )
  } else if (event.type === 'artifact.delivery_selected') {
    content = (
      <ArtifactMessage
        event={event}
        fallbackRunId={fallbackRunId}
        label="Delivery:"
        onOpenArtifact={onOpenArtifact}
        tone="delivery"
      />
    )
  } else if (event.type === 'tool.execution_logged') {
    content = (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-xs text-primary-text">
        <span className="font-medium">Tool:</span>
        <span>{event.content ?? 'Executed'}</span>
      </div>
    )
  } else if (event.content) {
    content = <p className="text-sm leading-relaxed text-foreground">{event.content}</p>
  }

  return content ? <EventRow event={event}>{content}</EventRow> : null
}

function AgentMessageGroup({
  group,
  color,
  onOpenArtifact,
  runId,
}: {
  group: MessageGroup
  color: string
  onOpenArtifact?: ((target: ArtifactPreviewTarget) => void) | undefined
  runId?: string | undefined
}) {
  return (
    <div className="flex gap-2.5">
      <AgentIdentityAvatar name={group.agentName} color={color} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span>{formatDisplayName(group.agentName)}</span>
          {group.provider ? (
            <ProviderModelIcon
              model={group.model}
              provider={group.provider}
            />
          ) : null}
          {group.modelSelection?.source === "app-default" ? (
            <span
              className="rounded-md bg-muted px-1.5 py-0.5 font-normal"
              title={describeModelSelection(
                group.agentName,
                group.modelSelection,
              )}
            >
              app default
            </span>
          ) : null}
        </div>
        <div className="space-y-1.5">
          {group.events.map((event) => (
            <EventMessage
              key={event.id}
              event={event}
              fallbackRunId={runId}
              onOpenArtifact={onOpenArtifact}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── DiscussionRenderer ────────────────────────────────────────────────────

/**
 * Renders a discussion-type stage as a chat-style conversation view.
 *
 * Features:
 * - Fetches agent display colours from GET /api/team on mount; falls back to
 *   a static 6-colour palette if the endpoint is unavailable.
 * - Groups consecutive events from the same agent into a single card, with
 *   the agent's avatar (initials circle) and name shown once per group.
 * - Inserts a round stage-name separator whenever `stageName` changes
 *   between groups.
 */
export function DiscussionRenderer({ events, onOpenArtifact, runId }: StageRendererProps) {
  const [serverColors, setServerColors] = useState<Record<string, string>>({})

  // Fetch agent colours from the API once on mount.
  // GET /api/team is added by T7; this component falls back gracefully if
  // the endpoint is not yet available or returns an error.
  useEffect(() => {
    let cancelled = false

    fetch(`${API_BASE}/team`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ agents: TeamAgent[] }>
      })
      .then((data) => {
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const agent of data.agents) {
          if (agent.color) map[agent.id] = agent.color
        }
        setServerColors(map)
      })
      .catch(() => {
        // Silently fall back to static FALLBACK_PALETTE
      })

    return () => {
      cancelled = true
    }
  }, [])

  const groups = useMemo(() => buildGroups(events), [events])

  // Build a stable agentId → display colour mapping.
  // Server colours take priority; unknown agents get a fallback palette slot
  // based on their first-seen order.
  const agentColorMap = useMemo<Record<string, string | undefined>>(() => {
    const indexByAgent = new Map<string, number>()
    let nextIdx = 0

    for (const group of groups) {
      if (!indexByAgent.has(group.agentId)) {
        indexByAgent.set(group.agentId, nextIdx++)
      }
    }

    const result: Record<string, string | undefined> = {}
    for (const [agentId, idx] of indexByAgent) {
      result[agentId] =
        serverColors[agentId] ?? FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length]
    }
    return result
  }, [groups, serverColors])

  if (groups.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        No events yet
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {groups.map((group, i) => {
        const prevGroup = groups[i - 1]
        // Show a stage separator when the stageName changes between groups,
        // but only when there is a meaningful stage name to display.
        const showSeparator =
          i > 0 &&
          group.stageName !== undefined &&
          group.stageName !== prevGroup?.stageName

        return (
          <div key={`${group.agentId}-${i}`}>
            {showSeparator && group.stageName !== undefined && (
              <StageSeparator stageName={group.stageName} />
            )}
            <AgentMessageGroup
              group={group}
              color={
                agentColorMap[group.agentId] ?? FALLBACK_PALETTE[0]
              }
              onOpenArtifact={onOpenArtifact}
              runId={runId}
            />
          </div>
        )
      })}
    </div>
  )
}
