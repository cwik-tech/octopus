import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deleteAgent, listAgents } from "@/lib/clients/agent-generator-client";
import type { AgentSummary } from "@/lib/models/agent-generator-model";
import {
  addTeamBuilderAgent,
  createTeamBuilderTeam,
  deleteTeamBuilderTeam,
  listTeamBuilderTeams,
  readTeamBuilderTeam,
  removeTeamBuilderAgent,
  TeamRevisionConflictError,
  updateTeamBuilderTeam,
} from "@/lib/clients/team-builder-client";
import type { TeamBuilderDetail } from "@/lib/models/team-builder-model";
import {
  draftFromTeam,
  draftToInput,
  emptyDraft,
  sameTeamDraft,
} from "./team-draft";
import type { AddTeamAgentInput, TeamArchitectPanelProps } from "./types";
import { changeSavedTeamShape } from "@/lib/clients/team-builder-client";
import type { TeamShape } from "@contracts/schemas/team-shape";

type TeamEditorOptions = Pick<
  TeamArchitectPanelProps,
  "onDetailsOpenChange" | "onResourcesChanged" | "teamSelectionRequest"
>;

export function useTeamEditor(options: TeamEditorOptions) {
  const {
    onDetailsOpenChange,
    onResourcesChanged,
    teamSelectionRequest,
  } = options;
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  /**
   * The team on screen, readable from inside an outstanding request.
   *
   * A request that answers late is compared against this rather than against
   * the value it captured: the state itself is stale inside a closure, and the
   * user may have opened a different team since.
   */
  const selectedTeamIdRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<TeamBuilderDetail | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [creating, setCreating] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Bumped by every selection request, including one that names the team
  // already on screen. The Architect fills a Team's roster after it creates
  // the shell, so re-selecting the same id is the signal that what is on
  // screen has moved on, and reading the id alone would show a stale roster.
  const [detailRequest, setDetailRequest] = useState(0);
  // What the draft was editing at the last commit, read only when a detail
  // response lands. Adding either to the read effect's dependencies would
  // refire the read on every keystroke.
  const draftStateRef = useRef<{ dirty: boolean; teamId: string | null }>({
    dirty: false,
    teamId: null,
  });

  const loadTeams = useCallback(async () => {
    setError(null);
    try {
      const [, nextAgents] = await Promise.all([
        listTeamBuilderTeams(),
        listAgents(),
      ]);
      setAgents(nextAgents);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const refreshTeamsAfterMutation = useCallback(async () => {
    await loadTeams();
    await onResourcesChanged?.();
  }, [loadTeams, onResourcesChanged]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadTeams(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadTeams]);

  useEffect(() => {
    if (!selectedTeamId || creating) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setLoadingDetail(true);
      setError(null);
      void readTeamBuilderTeam(selectedTeamId)
        .then((team) => {
          if (cancelled) return;
          setDetail(team);
          // A re-read of the team already open must not discard edits the
          // user has typed but not saved.
          const keepDraft =
            draftStateRef.current.dirty &&
            draftStateRef.current.teamId === team.id;
          if (!keepDraft) setDraft(draftFromTeam(team));
        })
        .catch((loadError) => {
          if (!cancelled) {
            setError(
              loadError instanceof Error ? loadError.message : String(loadError),
            );
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingDetail(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [creating, detailRequest, selectedTeamId]);

  useEffect(() => {
    if (!teamSelectionRequest) return;
    const timeout = window.setTimeout(() => {
      setCreating(false);
      setSelectedTeamId(teamSelectionRequest.id);
      setDetailRequest((current) => current + 1);
      onDetailsOpenChange?.(true);
      setError(null);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [onDetailsOpenChange, teamSelectionRequest]);

  const availableAgents = useMemo(() => {
    const used = new Set(detail?.agents.map((agent) => agent.name) ?? []);
    return agents.filter((agent) => !used.has(agent.name));
  }, [agents, detail]);
  const rosterAgentsForDelete = useMemo(
    () => detail?.agents.filter((agent) => agent.type === "agent") ?? [],
    [detail],
  );
  const cleanDraft = useMemo(
    () => (detail ? draftFromTeam(detail) : emptyDraft()),
    [detail],
  );
  const draftDirty = creating
    ? draft.id.trim().length > 0 ||
      draft.description.trim().length > 0 ||
      draft.tagsInput.trim().length > 0
    : detail
      ? !sameTeamDraft(draft, cleanDraft)
      : false;
  useEffect(() => {
    draftStateRef.current = { dirty: draftDirty, teamId: detail?.id ?? null };
  }, [detail, draftDirty]);
  const canSave =
    !saving && !loadingDetail && draft.id.trim().length > 0 && draftDirty;
  const canDelete = !saving && !creating && !!selectedTeamId && !!detail;
  /** The outstanding change, so a superseded one can be let go of. */
  const shapeChangeAbortRef = useRef<AbortController | null>(null);
  /**
   * The change in flight, and the team it is about.
   *
   * Kept together rather than cleared when the selection moves: a pending state
   * and a refusal both belong to one team, and deriving that is simpler — and
   * more correct — than an effect racing the next render to clear them.
   */
  const [shapeChange, setShapeChange] = useState<
    { teamId: string; pending: boolean; notice: string | null } | null
  >(null);
  useEffect(() => {
    selectedTeamIdRef.current = selectedTeamId;
    // A change belongs to the team it was made on. Opening another lets go of
    // it rather than waiting on an answer nobody is looking for.
    shapeChangeAbortRef.current?.abort();
    shapeChangeAbortRef.current = null;
    // And the same on the way out: a request nobody is left to receive is
    // given up rather than running on after the editor is gone.
    return () => {
      shapeChangeAbortRef.current?.abort();
      shapeChangeAbortRef.current = null;
    };
  }, [selectedTeamId]);
  // Only ever about the team on screen: a change the user has left behind
  // neither disables this team's control nor shows its refusal here.
  const shapeChangePending = shapeChange?.teamId === selectedTeamId
    ? shapeChange.pending
    : false;
  const shapeNotice = shapeChange?.teamId === selectedTeamId
    ? shapeChange.notice
    : null;

  const currentTitle = creating
    ? "New team"
    : draft.id.trim() || detail?.name || selectedTeamId || "Team setup";

  /**
   * Changes how the saved team works together.
   *
   * Written against the revision of the detail on screen — the same bytes the
   * shape itself was read from — so the two cannot describe different files.
   * A draft the user has typed but not saved is untouched: this operation is
   * about the team as it is stored, not about their unsaved edits.
   */
  async function changeShape(next: TeamShape): Promise<void> {
    const current = detail;
    if (!current || shapeChangePending) return;
    // The team this call is about. Every answer below is applied only while it
    // is still the team on screen: a change can answer long after the user has
    // opened a different one, and applying it then replaced the team they were
    // looking at with a different one.
    const changingTeamId = current.id;
    // This request still owns the editor's attention: the same team is on
    // screen *and* this is still the outstanding call. Selection alone is not
    // enough — a user who leaves a team and comes back is looking at a fresh
    // read of it, and an answer about the request they abandoned says nothing
    // about what they are now seeing.
    const stillMine = (): boolean =>
      selectedTeamIdRef.current === changingTeamId &&
      shapeChangeAbortRef.current === owned &&
      !owned.signal.aborted;
    const owned = new AbortController();
    shapeChangeAbortRef.current?.abort();
    shapeChangeAbortRef.current = owned;
    setShapeChange({ teamId: changingTeamId, pending: true, notice: null });
    try {
      const result = await changeSavedTeamShape({
        teamId: changingTeamId,
        shape: next,
        expectedRevision: current.revision,
        signal: owned.signal,
      });
      if (!stillMine()) return;
      if (!result.ok) {
        setShapeChange({
          teamId: changingTeamId,
          pending: false,
          notice: result.message,
        });
        // A refusal that carried the team is the editor's chance to redraw
        // from what is actually there. Their unsaved draft is theirs and is
        // left alone.
        if (result.team) {
          setDetail(result.team);
          if (!draftStateRef.current.dirty) setDraft(draftFromTeam(result.team));
        }
        return;
      }
      // Only the team as stored is replaced. A dirty draft is the user's own
      // unsaved work and is not this operation's to discard.
      setDetail(result.team);
      if (!draftStateRef.current.dirty) setDraft(draftFromTeam(result.team));
    } catch (changeError) {
      if (!stillMine()) return;
      setShapeChange({
        teamId: changingTeamId,
        pending: false,
        notice: changeError instanceof Error
          ? `That change could not be saved: ${changeError.message}`
          : "That change could not be saved.",
      });
    } finally {
      // The flag belongs to whichever call still owns it: clearing it when a
      // newer call has taken over would turn off a state that call had set.
      // But it is cleared whatever team is on screen — leaving it set because
      // the user moved on left the team they moved to unusable.
      // A newer change for the same team has taken the state over, and its
      // pending is not this call's to clear. Anything else — including a change
      // the user walked away from — settles here: a pending state that outlives
      // its request leaves that team's control disabled for good.
      const supersededBySameTeam = shapeChangeAbortRef.current !== null &&
        shapeChangeAbortRef.current !== owned;
      if (!supersededBySameTeam) {
        if (shapeChangeAbortRef.current === owned) shapeChangeAbortRef.current = null;
        setShapeChange((current) =>
          current?.teamId === changingTeamId && current.pending
            ? { ...current, pending: false }
            : current
        );
      }
    }
  }

  /**
   * Shows a write refused because the team changed since it was loaded.
   *
   * The same as a refused shape change: while it is still the team on screen,
   * the server's words and the team redrawn from what it now is. The person's
   * unsaved draft is theirs and is left alone. The next write then names the
   * revision they have now seen, so nothing is read just to pass the check.
   */
  function showRefusedWrite(refusal: TeamRevisionConflictError) {
    // A refusal about a team the person has since left says nothing about the
    // team now on screen.
    if (selectedTeamIdRef.current !== refusal.team.id) return;
    setError(refusal.message);
    setDetail(refusal.team);
    if (!draftStateRef.current.dirty) setDraft(draftFromTeam(refusal.team));
  }

  async function saveTeam() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const input = draftToInput(draft);
      const nextTeam = creating
        ? await createTeamBuilderTeam(input)
        : await updateTeamBuilderTeam(selectedTeamId ?? draft.id, input, detail?.revision);
      setCreating(false);
      setSelectedTeamId(nextTeam.id);
      onDetailsOpenChange?.(true);
      setDetail(nextTeam);
      setDraft(draftFromTeam(nextTeam));
      setSaved("Saved");
      await refreshTeamsAfterMutation();
    } catch (saveError) {
      if (saveError instanceof TeamRevisionConflictError) {
        showRefusedWrite(saveError);
        return;
      }
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function deleteTeam(agentNames: string[], onDeleted?: () => void) {
    if (!selectedTeamId || creating) return;
    setSaving(true);
    setError(null);
    try {
      await deleteTeamBuilderTeam(selectedTeamId, detail?.revision);
      for (const agentName of agentNames) {
        await deleteAgent({ agentName, deleteSkills: true });
      }
      setSelectedTeamId(null);
      setDetail(null);
      onDeleted?.();
      await refreshTeamsAfterMutation();
    } catch (deleteError) {
      if (deleteError instanceof TeamRevisionConflictError) {
        showRefusedWrite(deleteError);
        return;
      }
      setError(
        deleteError instanceof Error ? deleteError.message : String(deleteError),
      );
    } finally {
      setSaving(false);
    }
  }

  async function addAgent(input: AddTeamAgentInput, onAdded?: () => void) {
    if (!selectedTeamId || !input.agentName) return false;
    setSaving(true);
    setError(null);
    try {
      const nextTeam = await addTeamBuilderAgent({
        teamId: selectedTeamId,
        agentName: input.agentName,
        expectedRevision: detail?.revision,
      });
      setDetail(nextTeam);
      onAdded?.();
      await refreshTeamsAfterMutation();
      return true;
    } catch (addError) {
      if (addError instanceof TeamRevisionConflictError) {
        showRefusedWrite(addError);
        return false;
      }
      setError(addError instanceof Error ? addError.message : String(addError));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function removeAgent(agentName: string) {
    if (!selectedTeamId) return;
    setSaving(true);
    setError(null);
    try {
      const nextTeam = await removeTeamBuilderAgent({
        teamId: selectedTeamId,
        agentName,
        expectedRevision: detail?.revision,
      });
      setDetail(nextTeam);
      await refreshTeamsAfterMutation();
    } catch (removeError) {
      if (removeError instanceof TeamRevisionConflictError) {
        showRefusedWrite(removeError);
        return;
      }
      setError(
        removeError instanceof Error ? removeError.message : String(removeError),
      );
    } finally {
      setSaving(false);
    }
  }

  const adoptBuiltTeam = useCallback(
    (team: TeamBuilderDetail, savedLabel?: string) => {
      setCreating(false);
      setSelectedTeamId(team.id);
      onDetailsOpenChange?.(true);
      setDetail(team);
      setDraft(draftFromTeam(team));
      if (savedLabel !== undefined) setSaved(savedLabel);
    },
    [onDetailsOpenChange],
  );

  const applyTeamSnapshot = useCallback((team: TeamBuilderDetail) => {
    setDetail(team);
    setDraft(draftFromTeam(team));
  }, []);

  return {
    agents,
    selectedTeamId,
    detail,
    changeShape,
    shapeChangePending,
    shapeNotice,
    draft,
    creating,
    loadingDetail,
    saving,
    error,
    saved,
    availableAgents,
    rosterAgentsForDelete,
    canSave,
    canDelete,
    currentTitle,
    setDraft,
    setDetail,
    setSelectedTeamId,
    setSaved,
    saveTeam,
    deleteTeam,
    addAgent,
    removeAgent,
    adoptBuiltTeam,
    applyTeamSnapshot,
    refreshTeamsAfterMutation,
  };
}

export type TeamEditorController = ReturnType<typeof useTeamEditor>;
