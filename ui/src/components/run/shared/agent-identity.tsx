import type { CSSProperties, ReactNode } from "react";

import {
  agentInitials,
  formatAgentDisplayName,
} from "@/components/run/shared/agent-identity-model";
import { ProviderModelIcon } from "@/components/ui/provider-model-icon";
import { agentAvatarColorClass } from "@/lib/utils/agent-chat-colors";
import { cn } from "@/lib/utils/utils";

export function AgentIdentity({
  avatarColor,
  avatarSize = "md",
  className,
  colorClass,
  label,
  model,
  name,
  provider,
  secondary,
  trailing,
}: {
  avatarColor?: string;
  avatarSize?: "sm" | "md";
  className?: string;
  colorClass?: string | null | undefined;
  label?: string;
  model?: string | undefined;
  name: string;
  provider?: string | undefined;
  secondary?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <AgentIdentityAvatar
        color={avatarColor}
        colorClass={colorClass}
        name={name}
        size={avatarSize}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 font-semibold",
            colorClass ?? "text-foreground",
          )}
        >
          <span className="truncate">
            {label ?? formatAgentDisplayName(name)}
          </span>
          {provider ? (
            <ProviderModelIcon model={model} provider={provider} />
          ) : null}
        </span>
        {secondary ? (
          <span className="mt-0.5 block text-muted-foreground">
            {secondary}
          </span>
        ) : null}
      </span>
      {trailing}
    </div>
  );
}

export function AgentIdentityAvatar({
  className,
  color,
  colorClass,
  name,
  size = "md",
}: {
  className?: string;
  color?: string | undefined;
  colorClass?: string | null | undefined;
  name: string;
  size?: "sm" | "md";
}) {
  const style: CSSProperties | undefined = color
    ? { backgroundColor: color }
    : undefined;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border font-bold uppercase",
        size === "md" ? "size-8 text-xs" : "size-7 text-xs",
        color
          ? "border-transparent text-white"
          : agentAvatarColorClass(colorClass),
        className,
      )}
      style={style}
    >
      {agentInitials(name)}
    </span>
  );
}
