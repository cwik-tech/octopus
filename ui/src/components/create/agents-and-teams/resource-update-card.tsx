import { PlannedAgentInternetAccess, type PlannedInternetAccessProps } from "./planned-agent-internet-access";
import { Bot, PencilLine, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  CreateResourceRef,
  ResourceBuildEvent,
  ResourceBuildItem,
  ResourceBuildItemStatus,
  ResourceSkillUpdate,
  ResourceSkillUpdateStatus,
  ResourceUpdateOperation,
} from "@/lib/models/resource-architect-model";
import { formatDisplayName } from "@/lib/utils/display-name";
import { StatusLabel } from "./resource-creation-card";

/**
 * Proposal card for one update operation.
 *
 * The plan discriminator decides that this is an update — never a separately
 * supplied list of Team ids — and pressing `Apply update` is the only thing
 * that authorizes a write. One card answers for one operation, so everything
 * it reads out of the job is scoped to that operation's own plan index.
 */
export function ResourceUpdateCard(props: PlannedInternetAccessProps & {
  operation: ResourceUpdateOperation;
  planIndex: number;
  item?: ResourceBuildItem | undefined;
  events?: ResourceBuildEvent[] | undefined;
  onOpen: (resource: CreateResourceRef) => void;
  onApply?: (() => void) | undefined;
  applyDisabled?: boolean;
  onRetry?: (() => void) | undefined;
  /**
   * Why this plan offers no Retry, when it offers none.
   *
   * Shown where the button would have been, so the user reads the reason in
   * the place they were about to press.
   */
  retryBlockedReason?: string | undefined;
}) {
  const buildCancelled = props.events?.some(
    (event) => event.type === "build_cancelled",
  ) ?? false;
  // A withdrawn job marks the whole build cancelled, including the operations
  // that had already finished. An operation that reports a terminal status is
  // describing a change that is on disk, so it keeps saying so; cancellation
  // answers only for an operation that never reached one.
  const status = isTerminalStatus(props.item?.status)
    ? props.item.status
    : buildCancelled
      ? "cancelled"
      : props.item?.status ?? "planned";
  const published = props.item?.resource;
  const target = props.operation.target;
  const additions = props.operation.kind === "add_team_agents"
    ? resolveAdditions(
      props.operation,
      props.events ?? [],
      props.planIndex,
      status,
    )
    : [];
  const skillUpdates = props.operation.kind === "update_agent_skills"
    ? resolveSkillUpdates(props.operation.skillUpdates, props.events ?? [], props.planIndex, status)
    : [];
  const TargetIcon = target.kind === "team" ? Users : Bot;

  return (
    <Card size="sm" aria-label={`Update ${target.kind} ${target.id}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TargetIcon className="size-4" />
          {`Update ${target.kind === "team" ? "Team" : "Agent"} ${formatDisplayName(target.id)}`}
        </CardTitle>
        <CardDescription>{describeOperation(props.operation)}</CardDescription>
        <CardAction>
          <StatusLabel status={status} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="font-mono text-xs text-muted-foreground">{target.id}</div>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {additions.map((addition) => (
            <li
              key={addition.name}
              aria-label={`${formatDisplayName(addition.name)} ${addition.status.replace("_", " ")}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2"
            >
              <span className="flex items-center gap-2">
                <Bot className="size-3 shrink-0" />
                {formatDisplayName(addition.name)}
              </span>
              <StatusLabel status={addition.status} />
              {addition.error ? (
                <span className="col-span-2 text-destructive" role="alert">
                  {addition.error}
                </span>
              ) : null}
            </li>
          ))}
          {skillUpdates.map((skill) => (
            <li
              key={skill.name}
              aria-label={`${describeSkillAction(skill)} skill ${skill.name} ${skill.status}`}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2"
            >
              <span className="flex items-center gap-2 font-mono">
                <PencilLine className="size-3 shrink-0" />
                {skill.name}
              </span>
              <Badge variant="outline">{skill.action}</Badge>
              <StatusLabel status={skill.status} />
              {skill.error ? (
                <span className="col-span-3 text-destructive" role="alert">
                  {skill.error}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {props.item?.error ? (
          <p className="text-xs text-destructive" role="alert">
            {props.item.error}
          </p>
        ) : null}
        {props.retryBlockedReason ? (
          <p className="text-xs text-muted-foreground">{props.retryBlockedReason}</p>
        ) : null}
        {props.operation.kind === "add_team_agents" ? props.operation.newAgentsToCreate.map((agent) => (
          <PlannedAgentInternetAccess key={agent.name} agent={agent} showName onWebResearchChange={props.onWebResearchChange} webResearchDisabled={props.webResearchDisabled} webResearchNotice={props.webResearchNotice} />
        )) : null}
        <div className="flex gap-2">
          {published ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => props.onOpen(published)}
            >
              Open {published.id}
            </Button>
          ) : null}
          {props.onApply ? (
            <Button size="sm" disabled={props.applyDisabled} onClick={props.onApply}>
              Apply update
            </Button>
          ) : null}
          {props.onRetry ? (
            <Button size="sm" variant="outline" onClick={props.onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** Whether an item has reached an outcome nothing later can take back. */
function isTerminalStatus(
  status: ResourceBuildItemStatus | undefined,
): status is Exclude<ResourceBuildItemStatus, "planned" | "generating"> {
  return status !== undefined && status !== "planned" && status !== "generating";
}

/** `Create` or `Update`, for a label a screen reader can read as a sentence. */
function describeSkillAction(skill: ResourceSkillUpdate): string {
  return skill.action === "create" ? "Create" : "Update";
}

interface SkillUpdateRow extends ResourceSkillUpdate {
  status: ResourceSkillUpdateStatus;
  error?: string;
}

function resolveSkillUpdates(
  skills: readonly ResourceSkillUpdate[],
  events: readonly ResourceBuildEvent[],
  planIndex: number,
  operationStatus: ResourceBuildItemStatus,
): SkillUpdateRow[] {
  return skills.map((skill) => ({
    ...skill,
    ...resolveSkillUpdateStatus(skill.name, events, planIndex, operationStatus),
  }));
}

/**
 * Where one skill of this operation stands, from the latest event about it.
 *
 * Resolved by plan index and skill name, because two operations can name the
 * same skill. A skill with no event is planned. An operation-level failure
 * names no skill, so it leaves each row at the last status its own events
 * proved: a row is failed only when a skill event says so. A skill still marked
 * as being authored when its operation stopped is interrupted or cancelled with
 * the operation; otherwise its authoring left nothing durable, so it is
 * planned again.
 */
function resolveSkillUpdateStatus(
  name: string,
  events: readonly ResourceBuildEvent[],
  planIndex: number,
  operationStatus: ResourceBuildItemStatus,
): { status: ResourceSkillUpdateStatus; error?: string } {
  const event = [...events].reverse().find((candidate) =>
    candidate.planIndex === planIndex && candidate.skill?.name === name
  );
  switch (event?.type) {
    case "skill_generating":
      if (operationStatus === "planned" || operationStatus === "generating") {
        return { status: "generating" };
      }
      if (operationStatus === "interrupted" || operationStatus === "cancelled") {
        return { status: operationStatus };
      }
      return { status: "planned" };
    case "skill_staged":
      return { status: "staged" };
    case "skill_updated":
      return { status: "updated" };
    case "skill_failed":
      return { status: "failed", error: event.message };
    case "skill_cancelled":
      return { status: "cancelled" };
    default:
      return { status: "planned" };
  }
}

function describeOperation(operation: ResourceUpdateOperation): string {
  if (operation.kind === "update_agent_skills") {
    const count = operation.skillUpdates.length;
    return count === 1
      ? "Changes one skill on this existing Agent."
      : `Changes ${count} skills on this existing Agent.`;
  }
  const count =
    operation.libraryAgentsToAdd.length + operation.newAgentsToCreate.length;
  return count === 1
    ? "Adds one Agent to this existing Team."
    : `Adds ${count} Agents to this existing Team.`;
}

interface UpdateAddition {
  name: string;
  reused: boolean;
  status: ResourceBuildItemStatus;
  error?: string;
}

function resolveAdditions(
  operation: Extract<ResourceUpdateOperation, { kind: "add_team_agents" }>,
  events: ResourceBuildEvent[],
  planIndex: number,
  operationStatus: ResourceBuildItemStatus,
): UpdateAddition[] {
  const named = [
    ...operation.libraryAgentsToAdd.map((agent) => ({ name: agent.name, reused: true })),
    ...operation.newAgentsToCreate.map((agent) => ({ name: agent.name, reused: false })),
  ];
  return named.map(({ name, reused }) => ({
    name,
    reused,
    ...resolveAdditionStatus(name, reused, events, planIndex, operationStatus),
  }));
}

/**
 * The latest event this operation raised about one Agent.
 *
 * An update operation is planned against its target, so the events it raises
 * name the Team as `plannedResource` and the Agent they are about in
 * `resource`. Matching on `plannedResource` alone would find nothing. The plan
 * index is what keeps two operations apart: one plan may add the same library
 * Agent to two Teams, and each card must answer only for its own operation.
 */
function resolveAdditionStatus(
  name: string,
  reused: boolean,
  events: ResourceBuildEvent[],
  planIndex: number,
  operationStatus: ResourceBuildItemStatus,
): { status: ResourceBuildItemStatus; error?: string } {
  const operationCancelled = operationStatus === "cancelled";
  const event = [...events].reverse().find((candidate) => {
    if (candidate.planIndex !== planIndex) return false;
    if (candidate.resource?.kind === "agent") return candidate.resource.id === name;
    // Generation events come from the shared planned-Agent builder, which
    // plans against the Agent itself and carries no `resource` until the
    // package exists. That shape still names the Agent this row is about.
    return (
      candidate.plannedResource?.kind === "agent" &&
      candidate.plannedResource.id === name
    );
  });
  if (!event) return { status: operationCancelled ? "cancelled" : "planned" };
  switch (event.type) {
    case "agent_added":
      return { status: reused ? "reused" : "created" };
    case "agent_created":
      return { status: "created" };
    case "agent_reused":
      return { status: "reused" };
    case "agent_generating":
      if (operationCancelled) return { status: "cancelled" };
      // A terminal operation cannot still be generating. This also handles
      // older saved jobs that have no event for a retained private package.
      if (operationStatus === "failed" || operationStatus === "interrupted") {
        return { status: "interrupted" };
      }
      return { status: "generating" };
    case "agent_needs_input":
      return { status: "needs_input", error: event.message };
    case "agent_failed":
      return { status: "failed", error: event.message };
    case "agent_cancelled":
      return { status: "cancelled", error: event.message };
    default:
      return { status: operationCancelled ? "cancelled" : "planned" };
  }
}
