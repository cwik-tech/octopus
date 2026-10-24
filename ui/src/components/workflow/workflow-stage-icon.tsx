import type { SVGProps } from "react";
import {
  WORKFLOW_STAGE_ICON_META,
  type WorkflowStageType,
} from "./workflow-stage-types";

interface WorkflowStageIconProps extends Omit<SVGProps<SVGSVGElement>, "type"> {
  type: WorkflowStageType;
  /** Hides the icon from assistive technology when adjacent text supplies its label. */
  decorative?: boolean;
}

/**
 * Semantic inline SVGs for the six workflow orchestration patterns.
 *
 * They use `currentColor`, so they remain legible in buttons, badges, and both themes.
 */
export function WorkflowStageIcon({
  type,
  decorative = false,
  "aria-label": ariaLabel,
  className,
  ...props
}: WorkflowStageIconProps) {
  const meta = WORKFLOW_STAGE_ICON_META[type];

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : (ariaLabel ?? `${meta.label} workflow`)}
      {...props}
    >
      {type === "routing" ? <RoutingPaths /> : null}
      {type === "discussion" ? <DiscussionBubbles /> : null}
      {type === "pipeline" ? <PipelineSteps /> : null}
      {type === "chain" ? <ChainHandoffs /> : null}
      {type === "broadcast" ? <BroadcastFanOut /> : null}
      {type === "review" ? <ReviewLoop /> : null}
    </svg>
  );
}

function RoutingPaths() {
  return (
    <>
      <circle cx="5" cy="12" r="2" />
      <path d="M7 12h4m0 0 3-5m-3 5 3 5" />
      <circle cx="17" cy="7" r="2" />
      <circle cx="17" cy="17" r="2" />
    </>
  );
}

function DiscussionBubbles() {
  return (
    <>
      <path d="M4 5.5h10.5A2.5 2.5 0 0 1 17 8v3a2.5 2.5 0 0 1-2.5 2.5H10l-3.5 3v-3H4A2.5 2.5 0 0 1 1.5 11V8A2.5 2.5 0 0 1 4 5.5Z" />
      <path d="M17 10.5h3A2.5 2.5 0 0 1 22.5 13v2.5A2.5 2.5 0 0 1 20 18h-1.5v2.5L15.5 18" />
      <path d="M5.5 9.5h6" />
    </>
  );
}

function PipelineSteps() {
  return (
    <>
      <rect x="3" y="3.5" width="5" height="5" rx="1" />
      <rect x="16" y="3.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="15.5" width="5" height="5" rx="1" />
      <path d="M8 6h8m-5.5 2.5v4.25m5.5-4.25v4.25m-5.5 0h5.5m-5.5 0v2.75" />
    </>
  );
}

function ChainHandoffs() {
  return (
    <>
      <circle cx="4.5" cy="12" r="2.5" />
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="19.5" cy="12" r="2.5" />
      <path d="M7 12h2.5m5 0H17" />
      <path d="m8.5 10.5 1.5 1.5-1.5 1.5m7.5-3 1.5 1.5-1.5 1.5" />
    </>
  );
}

function BroadcastFanOut() {
  return (
    <>
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="18.5" cy="5" r="2" />
      <circle cx="18.5" cy="12" r="2" />
      <circle cx="18.5" cy="19" r="2" />
      <path d="M7.5 12h4m0 0 5-7m-5 7h5m-5 0 5 7" />
    </>
  );
}

function ReviewLoop() {
  return (
    <>
      <path d="M18.5 9.5A7.5 7.5 0 1 0 19 15" />
      <path d="M18.5 4.5v5h-5" />
      <path d="m9 13 2 2 4-4" />
    </>
  );
}
