import { Users } from "lucide-react";

import { PanelItem } from "@/components/ui/card";
import { TabsContent } from "@/components/ui/tabs";
import type { AgentDetail } from "@/lib/models/agent-generator-model";
import { formatDisplayName } from "@/lib/utils/display-name";
import { EmptyTab } from "./empty-tab";

export function AgentUsageTab(props: { agentDetail: AgentDetail | null }) {
  return (
    <TabsContent value="usage" className="min-h-0 flex-1 overflow-y-auto p-3">
      {props.agentDetail && props.agentDetail.usedInTeams.length > 0 ? (
        <div className="space-y-2">
          {props.agentDetail.usedInTeams.map((team) => (
            <PanelItem key={`${team.teamId}:${team.teamName}`}>
              <div className="flex items-center gap-2">
                <Users className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {formatDisplayName(team.teamName)}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {formatDisplayName(team.teamId)}
                  </div>
                </div>
              </div>
            </PanelItem>
          ))}
        </div>
      ) : (
        <EmptyTab>Not assigned to a team.</EmptyTab>
      )}
    </TabsContent>
  );
}
