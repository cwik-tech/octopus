import type {
  TeamBuilderDetail,
  TeamBuilderInput,
} from "@/lib/models/team-builder-model";
import type { TeamDraft } from "./types";

export function emptyDraft(): TeamDraft {
  return {
    id: "",
    description: "",
    tagsInput: "",
  };
}

export function draftFromTeam(team: TeamBuilderDetail): TeamDraft {
  return {
    id: team.id,
    description: team.description ?? "",
    tagsInput: team.tags.join(", "),
  };
}

export function draftToInput(draft: TeamDraft): TeamBuilderInput {
  return {
    id: draft.id,
    description: draft.description,
    tags: draft.tagsInput
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
}

export function sameTeamDraft(left: TeamDraft, right: TeamDraft): boolean {
  return (
    left.id === right.id &&
    left.description === right.description &&
    left.tagsInput === right.tagsInput
  );
}
