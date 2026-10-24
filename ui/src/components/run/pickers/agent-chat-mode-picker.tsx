import { AGENT_DIALOGUE_MAX_AGENTS, AGENT_DIALOGUE_MIN_AGENTS } from "@contracts/agent-dialogue";

import { FieldHelp } from "@/components/ui/field-help";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type AgentChatMode = "discussion" | "dialogue";

interface AgentChatModePickerProps {
  selectedCount: number;
  mode?: AgentChatMode;
  locked?: boolean;
  onModeChange: (mode: AgentChatMode) => void;
}

export function AgentChatModePicker({
  selectedCount,
  mode = "discussion",
  locked = false,
  onModeChange,
}: AgentChatModePickerProps) {
  if (selectedCount < AGENT_DIALOGUE_MIN_AGENTS) return null;
  const tooManyAgents = selectedCount > AGENT_DIALOGUE_MAX_AGENTS;

  return (
    <div className="mx-2 mb-3 shrink-0 space-y-1">
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground">Chat mode</span>
        <FieldHelp label="About chat modes">
          <div className="space-y-1">
            <p><strong>Discussion mode:</strong> Each selected Agent replies once to your message.</p>
            <p><strong>Talk to each other:</strong> Agents take short turns responding to each other. You can jump in, pause, or stop.</p>
          </div>
        </FieldHelp>
      </div>
      <Tabs
        value={tooManyAgents && !locked ? "discussion" : mode}
        onValueChange={(value: unknown) => {
          if (locked) return;
          if (value === "discussion" || (value === "dialogue" && !tooManyAgents)) {
            onModeChange(value);
          }
        }}
      >
        <TabsList aria-label="Agent chat mode" className="w-full">
          <TabsTrigger value="discussion" disabled={locked} className="text-xs">Discussion mode</TabsTrigger>
          <TabsTrigger value="dialogue" disabled={locked || tooManyAgents} className="text-xs">Talk to each other</TabsTrigger>
        </TabsList>
      </Tabs>
      {tooManyAgents ? <p className="text-xs text-muted-foreground">At most {AGENT_DIALOGUE_MAX_AGENTS} Agents can talk to each other.</p> : null}
    </div>
  );
}
