import { ArrowRight, Check, MessagesSquare, Repeat2 } from "lucide-react";
import { useId } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  validateShapeAgainstRoster,
  type TeamShape,
  type TeamShapeKind,
} from "@contracts/schemas/team-shape";

const KINDS: TeamShapeKind[] = ["chain", "discussion", "review"];
const OPTIONS = {
  chain: {
    title: "One after another",
    description: "Each agent works once, passing its result to the next. No feedback loop.",
    icon: ArrowRight,
  },
  discussion: {
    title: "Group discussion",
    description: "A lead selects the right agents and guides the group. Agents respond in turn and can build on earlier replies.",
    icon: MessagesSquare,
  },
  review: {
    title: "Draft and review",
    description: "One writes, one checks. The checker approves or requests changes. Two agents only.",
    icon: Repeat2,
  },
};

/**
 * Lets the user disagree with the shape the Architect proposed.
 *
 * Roles are filled from the roster in display order. The card names those
 * roles after the server accepts the change.
 *
 * A shape this roster cannot take is offered as disabled with the reason, not
 * hidden and not silently refused after the click. The reason comes from the
 * same contract the server refuses with, so the two cannot disagree.
 */
export function TeamShapeChooser(props: {
  /**
   * The shape in effect, or absent when there is none to repair from.
   *
   * Absence is represented as absence. An earlier version passed a fabricated
   * chain with an empty order, which preselected chain and failed the roster
   * rules, so the one option a broken plan most needed could not be chosen.
   */
  shape?: TeamShape;
  roster: readonly string[];
  onChoose: (shape: TeamShape) => Promise<void> | void;
  pending?: boolean;
}) {
  const descriptionId = useId();

  const candidates = KINDS.map((kind) => {
    const candidate = shapeForKind(kind, props.shape, props.roster);
    const verdict = candidate
      ? validateShapeAgainstRoster(candidate, props.roster)
      : { ok: false as const, reason: rosterTooSmall(kind) };
    return { kind, candidate, verdict };
  });

  return (
    <Tabs value={props.shape?.kind ?? null} onValueChange={(kind) => {
      const option = candidates.find((candidate) => candidate.kind === kind);
      if (props.pending || !option?.candidate || !option.verdict.ok || kind === props.shape?.kind) return;
      // The parent owns persistence and errors. Selection stays on the saved
      // shape until that request succeeds.
      void props.onChoose(option.candidate);
    }}>
      <TabsList aria-label="How they work together" className="grid w-full grid-cols-1 gap-3 bg-transparent p-0 group-data-horizontal/tabs:h-auto sm:grid-cols-3">
      {candidates.map(({ kind, candidate, verdict }) => {
        const { title, description, icon: Icon } = OPTIONS[kind];
        const disabled = !verdict.ok || props.pending === true;
        return (
          <TabsTrigger
            key={kind}
            value={kind}
            disabled={disabled || !candidate}
            aria-label={title}
            aria-describedby={`${descriptionId}-${kind}`}
            className="h-full min-w-0 flex-col gap-3 whitespace-normal rounded-lg border-border p-4 text-center data-active:border-primary data-active:bg-primary/10 dark:data-active:border-primary dark:data-active:bg-primary/10"
          >
            {props.shape?.kind === kind ? <Check aria-hidden="true" className="absolute right-2 top-2 size-4 text-primary-text" /> : null}
            <Icon aria-hidden="true" className="size-7" />
            <span className="text-sm font-medium">{title}</span>
            <span id={`${descriptionId}-${kind}`} className="text-xs font-normal text-muted-foreground">
              {verdict.ok ? description : verdict.reason}
            </span>
          </TabsTrigger>
        );
      })}
      </TabsList>
    </Tabs>
  );
}

/**
 * The chosen shape, with its roles taken from the roster in display order.
 *
 * Depth carries over: the user changed how the members work together, not how
 * far they go, and resetting it would quietly undo a separate decision.
 */
function shapeForKind(
  kind: TeamShapeKind,
  current: TeamShape | undefined,
  roster: readonly string[],
): TeamShape | null {
  // The shape already in effect is offered as it stands, so selecting it is a
  // no-op rather than a rewrite. With nothing in effect there is nothing to
  // return unchanged, and every kind is built fresh from the roster.
  if (current && kind === current.kind) return current;
  const rationale = "you chose it.";
  // A chain runs each member once and has no rounds; the depth reported for
  // one describes that rather than recording a choice. Carrying it turned every
  // chain changed into a discussion into a one-round discussion.
  const depth = current && current.kind !== "chain" ? current.depth : "standard";
  const [first, second, ...rest] = roster;

  if (kind === "chain") {
    if (roster.length < 1) return null;
    return { kind, rationale, depth, order: [...roster] };
  }
  if (kind === "discussion") {
    if (!first || !second) return null;
    return {
      kind,
      rationale,
      depth,
      coordinator: first,
      participants: [second, ...rest],
    };
  }
  if (!first || !second) return null;
  return { kind, rationale, depth, producer: first, reviewer: second };
}

/** Why a roster is too small for a shape, before any roles can be assigned. */
function rosterTooSmall(kind: TeamShapeKind): string {
  switch (kind) {
    case "chain":
      return "A team needs at least one member.";
    case "discussion":
      return "A discussion needs at least two team members.";
    case "review":
      return "A review team is one writer and one checker.";
  }
}
