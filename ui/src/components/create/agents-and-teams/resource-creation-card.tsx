import { PlannedAgentInternetAccess, type PlannedInternetAccessProps } from "./planned-agent-internet-access";
import { AgentBuildBriefDialog } from "./agent-build-brief-dialog";
import { Bot, CheckCircle2, Loader2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  CreateResourceRef,
  PlannedAgentSpec,
  ResourceBuildEvent,
  ResourceBuildItem,
  ResourceBuildItemStatus,
} from "@/lib/models/resource-architect-model";
import type { ResourceTeamPlan } from "@/lib/models/resource-architect-model";
import type { ResourceSkillUpdateStatus } from "@/lib/models/resource-architect-model";
import { formatDisplayName } from "@/lib/utils/display-name";
import type { TeamShape } from "@contracts/schemas/team-shape";
import {
  depthSentence,
  shapeHeadline,
  shapeAssignmentRoles,
  shapeOutputNote,
  rosterInShapeOrder,
  rosterIsNumbered,
  rosterOrderNote,
} from "@/components/create/agents-and-teams/team-shape-copy";
import { TeamShapeChooser } from "@/components/create/agents-and-teams/team-shape-chooser";
import { isPublishedResourceBuildItemStatus } from "@contracts/resource-architect";
import { plannedAgentCardSummary } from "@contracts/planned-agent-summary";

export function AgentCreationCard(props: PlannedInternetAccessProps & {
  agent: PlannedAgentSpec;
  item?: ResourceBuildItem | undefined;
  onOpen: (resource: CreateResourceRef) => void;
  onCreate?: (() => void) | undefined;
  createDisabled?: boolean;
  onRetry?: (() => void) | undefined;
}) {
  const status = props.item?.status ?? "planned";
  const published = publishedResource(props.item);
  // The card shows the summary. The build brief can run to thousands of
  // characters, so it opens on request, and only when it says more.
  const summary = plannedAgentCardSummary(props.agent);
  const brief = collapseWhitespace(props.agent.description);
  const briefSaysMore = brief !== "" && brief !== collapseWhitespace(summary);
  return (
    <Card size="sm" aria-label={`Agent ${props.agent.name}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" />
          {formatDisplayName(props.agent.name)}
        </CardTitle>
        {/* The title shows the rest of a summary the three-line cap cuts off. */}
        <CardDescription className="line-clamp-3" title={summary}>{summary}</CardDescription>
        <CardAction><StatusLabel status={status} /></CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {briefSaysMore ? (
          <AgentBuildBriefDialog agentName={props.agent.name} summary={summary} brief={props.agent.description} />
        ) : null}
        <div className="font-mono text-xs text-muted-foreground">{props.agent.name}</div>
        <p className="text-xs text-muted-foreground">{props.agent.rationale}</p>
        {props.item?.error ? (
          <p className="text-xs text-destructive" role="alert">
            {props.item.error}
          </p>
        ) : null}
        <PlannedAgentInternetAccess agent={props.agent} onWebResearchChange={props.onWebResearchChange} webResearchDisabled={props.webResearchDisabled} webResearchNotice={props.webResearchNotice} />
        <CardActions {...props} published={published} />
      </CardContent>
    </Card>
  );
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * How a team works together, stated rather than asked, with the control to
 * change it.
 *
 * The Architect already has the intent and the roster, so it infers the shape
 * and gives a reason — the same thing it already does per Agent. This renders
 * that decision where the user can see it and disagree with it, in the same
 * muted-rationale pattern the Agent rows use.
 *
 * Shared with the saved-team editor: a team reopened later has to describe
 * itself the same way it did when it was proposed, or the editor offers a
 * change without saying what is being changed.
 *
 * Absent on a plan recorded before shapes existed, and that plan builds the
 * chain it always built. Showing a shape block there would claim a decision
 * nobody made.
 */
export function TeamShapeBlock(props: {
  shape?: TeamShape | undefined;
  /**
   * The saved shape was read back as one this app cannot build.
   *
   * Different from having none. A plan that never chose a shape builds the
   * chain it was planned as and has nothing to repair; this one is refused by
   * the build, so the card has to say so and offer the way to fix it. Showing
   * nothing would look identical to the first case, and the user would press
   * Create and collect the same refusal again.
   */
  rejected?: boolean;
  roster: readonly string[];
  onChoose?: (shape: TeamShape) => Promise<void> | void;
  notice?: string;
  /**
   * How to read the notice.
   *
   * Two different things arrive here: a change the server refused, which is a
   * problem, and the settled state of a plan that has already been built from,
   * which is not. Painting the second one red reads as something having gone
   * wrong when nothing has.
   */
  noticeTone?: "error" | "info";
  /**
   * The plan's revision could not be read, and a way to ask for it again.
   *
   * Scoped to what is true in every case: a change is always written against
   * the revision, so without one there is nothing to change against. Whether
   * Create is also blocked depends on the plan — a shaped plan is held back,
   * and a plan that never chose a shape still builds the chain it was planned
   * as — so the sentence does not speak for it.
   *
   * The proposal is not what failed, so the way back is to read it again
   * rather than to describe the team afresh.
   */
  unavailable?: { onRetry: () => void; retrying?: boolean };
  pending?: boolean;
}) {
  const noticeClass = props.noticeTone === "info"
    ? "text-xs text-muted-foreground"
    : "text-xs text-destructive";
  const unavailable = props.unavailable
    ? (
      <div className="space-y-1">
        <p className="text-xs text-destructive" role="status">
          This plan's current version could not be read, so how this team works
          together cannot be changed yet.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          disabled={props.unavailable.retrying === true}
          onClick={props.unavailable.onRetry}
        >
          {props.unavailable.retrying ? "Trying again\u2026" : "Try again"}
        </Button>
      </div>
    )
    : null;
  const shape = props.shape;
  if (!shape) {
    if (!props.rejected) {
      // A plan that never chose a shape has nothing to say here — unless its
      // revision could not be read, which is the one thing the user can act on.
      // Such a plan can still be built: it builds the chain it was planned as,
      // and only changing how it works together needs the revision.
      if (!unavailable) return null;
      return (
        <section aria-label="How they work together" className="space-y-1">
          <h4 className="text-xs font-medium">How they work together</h4>
          {unavailable}
        </section>
      );
    }
    return (
      <section aria-label="How they work together" className="space-y-1">
        <h4 className="text-xs font-medium">How they work together</h4>
        <p className="text-xs text-destructive" role="status">
          This team's saved way of working together is no longer one this app can
          build. Choose it again before building.
        </p>
        {props.onChoose ? (
          <TeamShapeChooser
            onChoose={props.onChoose}
            roster={props.roster}
            {...(props.pending ? { pending: true } : {})}
          />
        ) : null}
        {unavailable}
        {props.notice ? (
          <p className={noticeClass} role="status">{props.notice}</p>
        ) : null}
      </section>
    );
  }
  const outputNote = shapeOutputNote(shape);
  return (
    <section aria-label="How they work together" className="space-y-1">
      <h4 className="text-xs font-medium">How they work together</h4>
      <p className="text-xs font-medium">{shapeAssignmentRoles(shape)}</p>
      <div className="space-y-3">
        <p className="text-xs">{shapeHeadline(shape.kind)}</p>
        {props.onChoose ? (
          <TeamShapeChooser
            onChoose={props.onChoose}
            roster={props.roster}
            shape={shape}
            {...(props.pending ? { pending: true } : {})}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{depthSentence(shape)}</p>
      <p className="text-xs text-muted-foreground">
        Chosen because {lowerFirst(shape.rationale)}
      </p>
      {outputNote ? (
        <p className="text-xs text-muted-foreground">{outputNote}</p>
      ) : null}
      {unavailable}
      {props.notice ? (
        <p className={noticeClass} role="status">{props.notice}</p>
      ) : null}
    </section>
  );
}

/**
 * Joins the Architect's sentence onto "Chosen because" without reading as two
 * sentences jammed together. An acronym or a name keeps its capital.
 */
function lowerFirst(sentence: string): string {
  const [first = "", second = ""] = [sentence.slice(0, 1), sentence.slice(1)];
  const startsWithProperNoun = /^[A-Z]/.test(second);
  return startsWithProperNoun ? sentence : `${first.toLowerCase()}${second}`;
}

export function TeamCreationCard(props: PlannedInternetAccessProps & {
  team: ResourceTeamPlan;
  item?: ResourceBuildItem | undefined;
  events?: ResourceBuildEvent[] | undefined;
  onOpen: (resource: CreateResourceRef) => void;
  onCreate?: () => void;
  createDisabled?: boolean;
  onRetry?: (() => void) | undefined;
  /**
   * Applies a shape the user picked instead of the proposed one.
   *
   * Absent where nothing can carry the change — a card rendered from a job
   * that has already been built, for instance. The control is then not shown
   * at all, rather than shown and doing nothing.
   */
  onShapeChange?: (shape: TeamShape) => Promise<void> | void;
  /** What the last attempt to change the shape had to say, if anything. */
  shapeNotice?: string;
  /** Whether that notice is a problem or simply the state of the plan. */
  shapeNoticeTone?: "error" | "info";
  /** The plan's revision could not be read, and how to ask for it again. */
  shapeUnavailable?: { onRetry: () => void; retrying?: boolean };
  /** A change is outstanding, so the control is not offered again meanwhile. */
  shapeChangePending?: boolean;
  /** Throws away the unfinished Team this build left behind, if it left one. */
  onDiscard?: () => void;
}) {
  const buildCancelled = props.events?.some(
    (event) => event.type === "build_cancelled",
  ) ?? false;
  const status = buildCancelled ? "cancelled" : props.item?.status ?? "planned";
  const published = publishedResource(props.item);
  const existingNames = new Set(
    props.team.existingAgents.map((agent) => agent.name),
  );
  const planned = [...props.team.existingAgents, ...props.team.newAgents];
  const shapeOrder = rosterInShapeOrder(
    planned.map((agent) => agent.name),
    props.team.shape,
  );
  const roster = [...planned]
    .sort((left, right) =>
      shapeOrder.indexOf(left.name) - shapeOrder.indexOf(right.name))
    .map((agent) => ({
    name: agent.name,
    ...resolveRosterStatus(
      agent.name,
      existingNames.has(agent.name),
      props.events ?? [],
      buildCancelled,
    ),
  }));
  return (
    <Card size="sm" aria-label={`Team ${props.team.teamId}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" />
          {formatDisplayName(props.team.teamId)}
        </CardTitle>
        <CardDescription>{props.team.description}</CardDescription>
        <CardAction><StatusLabel status={status} /></CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="font-mono text-xs text-muted-foreground">{props.team.teamId}</div>
        {roster.length > 0 ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {roster.map(({ name, status: rosterStatus, error }, position) => (
              <li
                key={name}
                aria-label={`${formatDisplayName(name)} ${rosterStatus.replace("_", " ")}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2"
              >
                <span>
                  {rosterIsNumbered(props.team.shape) ? `${position + 1}. ` : ""}
                  {formatDisplayName(name)}
                </span>
                <StatusLabel status={rosterStatus} />
                {error ? (
                  <span className="col-span-2 text-destructive" role="alert">
                    {error}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {rosterOrderNote(props.team.shape) ? (
          <p className="text-xs text-muted-foreground">
            {rosterOrderNote(props.team.shape)}
          </p>
        ) : null}
        <TeamShapeBlock
          shape={props.team.shape}
          rejected={props.team.shapeRejected === true}
          roster={roster.map((member) => member.name)}
          {...(props.onShapeChange ? { onChoose: props.onShapeChange } : {})}
          {...(props.shapeNotice ? { notice: props.shapeNotice } : {})}
          {...(props.shapeNoticeTone ? { noticeTone: props.shapeNoticeTone } : {})}
          {...(props.shapeUnavailable
            ? { unavailable: props.shapeUnavailable }
            : {})}
        />
        {props.team.newAgents.map((agent) => (
          <PlannedAgentInternetAccess key={agent.name} agent={agent} showName onWebResearchChange={props.onWebResearchChange} webResearchDisabled={props.webResearchDisabled} webResearchNotice={props.webResearchNotice} />
        ))}
        <CardActions {...props} published={published} />
      </CardContent>
    </Card>
  );
}

/**
 * The newest event that actually reports a status for this roster member.
 *
 * An event can name an Agent without saying anything about how far its build
 * has got — a skill repaired part-way through generation is one. Taking the
 * last event that named the Agent would let one of those push a row that is
 * mid-build back to "planned".
 */
function resolveRosterStatus(
  name: string,
  existing: boolean,
  events: ResourceBuildEvent[],
  buildCancelled: boolean,
): { status: ResourceBuildItemStatus; error?: string } {
  for (const event of [...events].reverse()) {
    if (
      event.plannedResource?.kind !== "agent" ||
      event.plannedResource.id !== name
    ) {
      continue;
    }
    const reported = rosterStatusFor(event, existing, buildCancelled);
    if (reported) return reported;
  }
  return { status: buildCancelled ? "cancelled" : "planned" };
}

/** What one event says about a roster row, or `null` when it says nothing. */
function rosterStatusFor(
  event: ResourceBuildEvent,
  existing: boolean,
  buildCancelled: boolean,
): { status: ResourceBuildItemStatus; error?: string } | null {
  switch (event.type) {
    case "agent_added":
      return { status: existing ? "reused" : "created" };
    case "agent_created":
      return { status: "created" };
    case "agent_reused":
      return { status: "reused" };
    case "agent_generating":
      return { status: buildCancelled ? "cancelled" : "generating" };
    case "agent_needs_input":
      return { status: "needs_input", error: event.message };
    case "agent_failed":
      return { status: "failed", error: event.message };
    case "agent_cancelled":
      return { status: "cancelled", error: event.message };
    default:
      return null;
  }
}

function CardActions(props: {
  item?: ResourceBuildItem | undefined;
  published?: CreateResourceRef | undefined;
  onOpen: (resource: CreateResourceRef) => void;
  onCreate?: (() => void) | undefined;
  createDisabled?: boolean;
  onRetry?: (() => void) | undefined;
  /**
   * Throws away the unfinished Team this build left behind.
   *
   * Offered only when there is one: a build that published its team has a real
   * team, which is deleted from the team editor and not from here.
   */
  onDiscard?: () => void;
}) {
  const discardable = Boolean(
    props.onDiscard &&
      props.item?.resource?.kind === "team" &&
      !isPublishedResourceBuildItemStatus(props.item.status),
  );
  const published = props.published;
  return (
    <div className="flex gap-2">
      {published ? (
        <Button size="sm" variant="outline" onClick={() => props.onOpen(published)}>
          Open {published.id}
        </Button>
      ) : null}
      {props.onCreate ? (
        <Button size="sm" disabled={props.createDisabled} onClick={props.onCreate}>
          Create
        </Button>
      ) : null}
      {props.onRetry ? <Button size="sm" variant="outline" onClick={props.onRetry}>Retry</Button> : null}
      {discardable
        ? (
          <Button size="sm" variant="ghost" onClick={props.onDiscard}>
            Discard
          </Button>
        )
        : null}
    </div>
  );
}

/**
 * The resource this item actually published, if it published one.
 *
 * An item records which resource it was working on whatever became of it —
 * retry and discard both need that identity, and a build that stopped still
 * made a Team shell. The reference alone is therefore not permission to open
 * anything: an unpublished shell has no roster and fails the moment it runs.
 */
function publishedResource(
  item: ResourceBuildItem | undefined,
): CreateResourceRef | undefined {
  if (!item?.resource) return undefined;
  return isPublishedResourceBuildItemStatus(item.status) ? item.resource : undefined;
}

/** Shared by the creation and update proposal cards so both read alike. */
export function StatusLabel({ status }: { status: ResourceBuildItemStatus | ResourceSkillUpdateStatus }) {
  const active = status === "planned" || status === "generating";
  const published = status === "created" || status === "reused" || status === "updated";
  return (
    <span className="flex items-center gap-1 text-xs capitalize text-muted-foreground">
      {active ? <Loader2 className="size-3 animate-spin" /> : published ? <CheckCircle2 className="size-3 text-emerald-500" /> : null}
      {status.replace("_", " ")}
    </span>
  );
}
