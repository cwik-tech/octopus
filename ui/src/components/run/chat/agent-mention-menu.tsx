import { Bot, Search } from "lucide-react";
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { PopoverContent } from "@/components/ui/popover";
import { mentionAgentIdentityKey } from "@/components/run/chat/use-agent-mentions";
import type { AgentSummary } from "@/lib/models/agent-generator-model";
import { formatDisplayName } from "@/lib/utils/display-name";

/**
 * The composer's @-mention suggestions: a search box and the Agents, those in
 * this chat first. Rendered inside the composer's Popover.
 */
export function AgentMentionMenu({
  activeIndex,
  agents,
  anchor,
  error,
  participatingAgentKeys,
  listboxId,
  loading,
  query,
  onActiveIndexChange,
  onQueryChange,
  onKeyDown,
  onSelect,
}: {
  activeIndex: number;
  agents: AgentSummary[];
  anchor: RefObject<HTMLElement | null>;
  error: string | null;
  participatingAgentKeys: ReadonlySet<string>;
  listboxId: string;
  loading: boolean;
  query: string;
  onActiveIndexChange: (index: number) => void;
  onQueryChange: (query: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onSelect: (agent: AgentSummary) => void;
}) {
  const selectedAgentName = agents[activeIndex]?.name ?? "";
  const searchRef = useRef<HTMLInputElement>(null);
  const inChatAgents = agents.filter((agent) =>
    participatingAgentKeys.has(mentionAgentIdentityKey(agent.name)),
  );
  const otherAgents = agents.filter((agent) =>
    !participatingAgentKeys.has(mentionAgentIdentityKey(agent.name)),
  );
  const groups = [
    { label: "In this chat", agents: inChatAgents, offset: 0 },
    { label: "Other agents", agents: otherAgents, offset: inChatAgents.length },
  ];

  useEffect(() => {
    const activeOption = document.getElementById(
      `${listboxId}-option-${activeIndex}`,
    );
    activeOption?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, agents.length, listboxId]);

  return (
    <PopoverContent
      align="start"
      anchor={anchor}
      className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(24rem,var(--available-height))] gap-0 overflow-hidden p-0"
      finalFocus={false}
      initialFocus={searchRef}
      side="top"
      sideOffset={8}
    >
      <div className="shrink-0 border-b p-2">
        <InputGroup>
          <InputGroupInput
            ref={searchRef}
            aria-label="Search agents to mention"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={selectedAgentName ? `${listboxId}-option-${activeIndex}` : undefined}
            role="combobox"
            placeholder="Search agents…"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <InputGroupAddon><Search className="size-4" /></InputGroupAddon>
        </InputGroup>
      </div>
      <div
        aria-label="Agent mentions"
        className="min-h-0 max-h-72 overflow-y-auto p-1"
        id={listboxId}
        role="listbox"
      >
        {loading ? (
          <div className="px-2 py-3 text-sm text-muted-foreground" role="status">
            Loading agents…
          </div>
        ) : error ? (
          <div className="px-2 py-3 text-sm text-destructive">
            Could not load agents: {error}
          </div>
        ) : agents.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">
            {query ? `No agents match @${query}.` : "No agents available."}
          </div>
        ) : (
          groups.map((group) => group.agents.length > 0 ? (
            <div key={group.label} role="group" aria-label={group.label}>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{group.label}</div>
              {group.agents.map((agent, groupIndex) => {
                const index = group.offset + groupIndex;
                return (
                  <Button
                    aria-selected={agent.name === selectedAgentName}
                    className={`h-9 w-full justify-start gap-2 px-2 text-left ${
                      agent.name === selectedAgentName
                        ? "bg-accent text-accent-foreground"
                        : ""
                    }`}
                    id={`${listboxId}-option-${index}`}
                    key={agent.name}
                    onClick={() => onSelect(agent)}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => onActiveIndexChange(index)}
                    role="option"
                    tabIndex={-1}
                    type="button"
                    variant="ghost"
                  >
                    <Bot className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate text-sm font-medium">
                      {formatDisplayName(agent.name)}
                    </span>
                  </Button>
                );
              })}
            </div>
          ) : null)
        )}
      </div>
    </PopoverContent>
  );
}
