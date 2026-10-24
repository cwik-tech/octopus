import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils/utils";

export type ChatWorkspaceProps = ComponentProps<"div">;

/**
 * Shared outer gutter for chat workspaces. Consumers may adjust vertical
 * spacing for their own fixed controls, but horizontal spacing stays aligned.
 */
export function ChatWorkspace({
  className,
  ...props
}: ChatWorkspaceProps) {
  return (
    <div
      {...props}
      className={cn(
        "flex min-h-0 flex-1 overflow-hidden px-4 pt-2 pb-3 lg:px-6 lg:pt-3 lg:pb-4",
        className,
      )}
      data-slot="chat-workspace"
    />
  );
}

interface ChatShellProps {
  children?: ReactNode;
  composer: ReactNode;
  conversation: ReactNode;
  header?: ReactNode;
  label: string;
  /** One line under the header, such as a notice about the chat's model. */
  notice?: ReactNode;
}

/**
 * Shared frame for interactive chat surfaces. Feature components own their
 * content and behavior; this component owns the common visual structure.
 */
export function ChatShell({
  children,
  composer,
  conversation,
  header,
  label,
  notice,
}: ChatShellProps) {
  return (
    <section
      aria-label={label}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-none border-0 bg-transparent p-0 text-card-foreground"
      data-slot="chat-shell"
    >
      {header !== undefined && header !== null ? (
        <div
          className="flex items-center justify-between gap-2 px-1 pt-1 pb-3"
          data-slot="chat-shell-header"
        >
          {header}
        </div>
      ) : null}
      {notice}
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-slot="chat-shell-conversation"
      >
        {conversation}
      </div>
      <div className="p-1" data-slot="chat-shell-composer">
        {composer}
      </div>
      {children}
    </section>
  );
}
