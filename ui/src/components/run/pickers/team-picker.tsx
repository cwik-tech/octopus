import { CircleAlert } from "lucide-react";
import { memo, startTransition, useEffect, useMemo, useState } from "react";

import { SidebarEmptyLabel } from "@/components/sidebar/sidebar-empty-label";
import { TeamItem } from "@/components/sidebar/team-item";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listCachedTeamBuilderTeams,
  subscribeToTeamBuilderTeams,
} from "@/lib/clients/team-builder-client";
import type { TeamBuilderSummary } from "@/lib/models/team-builder-model";
import { formatDisplayName } from "@/lib/utils/display-name";

interface TeamPickerProps {
  query: string;
  selectedTeamId: string | null;
  onSelectedTeamIdChange: (teamId: string | null) => void;
}

function TeamPickerComponent({
  query,
  selectedTeamId,
  onSelectedTeamIdChange,
}: TeamPickerProps) {
  const [teams, setTeams] = useState<TeamBuilderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // An invalidation can start a second request while the first is still in
    // flight. Only the newest may apply, or a slow pre-creation response
    // overwrites the catalog that already contains the new team.
    let latestRequest = 0;
    const load = () => {
      const request = ++latestRequest;
      startTransition(() => {
        setLoading(true);
        setError(null);
      });
      void listCachedTeamBuilderTeams()
        .then((next) => {
          if (cancelled || request !== latestRequest) return;
          startTransition(() => {
            setTeams(next);
            setLoading(false);
          });
        })
        .catch((err) => {
          if (cancelled || request !== latestRequest) return;
          startTransition(() => {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          });
        });
    };
    load();
    // Teams built by the Architect appear without this component remounting.
    const unsubscribe = subscribeToTeamBuilderTeams(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const filteredTeams = useMemo(() => {
    // Teams that declare themselves caller-only expect another team to
    // prepare their inputs, so chat must not offer them as a target.
    const launchable = teams.filter((team) => team.userInvocable !== false);
    const needle = query.trim().toLowerCase();
    if (!needle) return launchable;
    return launchable.filter(
      (team) =>
        team.id.toLowerCase().includes(needle) ||
        formatDisplayName(team.id).toLowerCase().includes(needle) ||
        team.description?.toLowerCase().includes(needle),
    );
  }, [teams, query]);

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-9 w-full rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  if (filteredTeams.length === 0) {
    return <SidebarEmptyLabel>No teams found.</SidebarEmptyLabel>;
  }

  return (
    <ul className="space-y-1" role="radiogroup" aria-label="Select Team">
      {filteredTeams.map((team) => {
        const selected = selectedTeamId === team.id;
        return (
          <li key={team.id}>
            <TeamItem
              label={formatDisplayName(team.id)}
              health={team.health}
              descriptionTooltip={team.description || "No description."}
              checked={selected}
              selected={selected}
              // A team is one target: re-picking the selected team clears it.
              onSelect={() => onSelectedTeamIdChange(selected ? null : team.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}

export const TeamPicker = memo(TeamPickerComponent);
