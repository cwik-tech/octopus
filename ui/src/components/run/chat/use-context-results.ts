import { useCallback, useEffect, useState } from "react";

import {
  MAX_CONTEXT_RESULTS_PER_TURN,
  type ResultReference,
} from "@contracts/schemas/result-reference";
import { listSessionResults } from "@/lib/clients/session-client";

/**
 * What this session can carry forward, and what the user chose to carry.
 *
 * Selection is by durable result id, never by position, so a reload restores
 * the same result rather than whatever is now third in the list.
 *
 * Preselection is deliberately timid. Exactly one available result and no
 * choice made yet is the one case where the intent is unambiguous; with
 * several, nothing is attached, because a wrong attachment is invisible in the
 * reply and reads exactly like a right one. A cleared preselection stays
 * cleared for the session.
 */
export interface ContextResultsState {
  readonly available: readonly ResultReference[];
  readonly selectedIds: readonly string[];
  readonly selected: readonly ResultReference[];
  /** False once this turn is carrying as many results as one may. */
  readonly canSelectMore: boolean;
  /**
   * Set when the last listing failed.
   *
   * The selection is kept and stays visible: the ids are still what Send will
   * carry, and hiding the chips while submitting them showed a turn carrying
   * nothing and sent one carrying a result.
   */
  readonly error: string | null;
  select(id: string): void;
  clear(id: string): void;
  clearAll(): void;
  refresh(): void;
}

/**
 * Where a session's selection is remembered across a reload.
 *
 * By durable result id, never by position. Best effort, because a private
 * window or blocked site data must cost the memory rather than the composer.
 */
const STORAGE_PREFIX = "pipeline-context-results:";

/**
 * What was stored, including the decision behind an empty selection.
 *
 * Ids alone could not tell "I cleared the only result" from "I have not
 * chosen yet", so the next load preselected the same result the user had just
 * removed. `decided` is that difference.
 */
interface StoredSelection {
  readonly selectedIds: readonly string[];
  readonly decided: boolean;
  readonly dismissed: readonly string[];
}

const EMPTY_STORED: StoredSelection = {
  selectedIds: [],
  decided: false,
  dismissed: [],
};

function readStoredSelection(sessionId: string): StoredSelection {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${sessionId}`);
    if (!raw) return EMPTY_STORED;
    const parsed: unknown = JSON.parse(raw);
    // The older shape was a bare array of ids. It carries no decision, so it
    // restores as one nobody has made, which is what it always meant.
    if (Array.isArray(parsed)) {
      return {
        selectedIds: parsed.filter(
          (entry): entry is string => typeof entry === "string",
        ),
        decided: false,
        dismissed: [],
      };
    }
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STORED;
    const record: Record<string, unknown> = { ...parsed };
    const ids = Array.isArray(record.selectedIds)
      ? record.selectedIds.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const dismissed = Array.isArray(record.dismissed)
      ? record.dismissed.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return { selectedIds: ids, decided: record.decided === true, dismissed };
  } catch {
    return EMPTY_STORED;
  }
}

function writeStoredSelection(
  sessionId: string,
  stored: StoredSelection,
): void {
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${sessionId}`,
      JSON.stringify({
        selectedIds: [...stored.selectedIds],
        decided: stored.decided,
        dismissed: [...stored.dismissed],
      }),
    );
  } catch {
    // A viewer whose browser refuses storage keeps the selection for this
    // visit and loses it on reload. That is the whole cost.
  }
}

/**
 * One conversation's selection, and the two facts that qualify it.
 *
 * Held as state rather than refs so switching session is a single render-time
 * adjustment. A conversation must never show another one's chips, which a
 * render-then-correct pass through an effect would allow.
 */
interface SelectionState {
  readonly sessionId: string | null;
  readonly selectedIds: readonly string[];
  /** Results the user removed. A preselection must not bring one back. */
  readonly dismissed: readonly string[];
  /** Whether this session has already had its one chance to preselect. */
  readonly preselected: boolean;
}

function initialSelection(sessionId: string | null): SelectionState {
  const stored = sessionId ? readStoredSelection(sessionId) : EMPTY_STORED;
  return {
    sessionId,
    selectedIds: stored.selectedIds,
    dismissed: stored.dismissed,
    // A restored choice is the user's own, so preselection has nothing left to
    // offer. That includes an empty one: clearing the only result is a
    // decision, and re-attaching it on the next load undoes it silently.
    preselected: stored.decided || stored.selectedIds.length > 0,
  };
}

/**
 * @param sessionId The conversation to list results for, or `null` when there
 * is none to ask about yet. A draft is `null`: it exists only in the renderer,
 * so asking the server about it answers 404 and the composer would open every
 * new conversation under an error about a session that was never created.
 */
export function useContextResults(
  sessionId: string | null,
): ContextResultsState {
  const [available, setAvailable] = useState<ResultReference[]>([]);
  const [selection, setSelection] = useState<SelectionState>(() =>
    initialSelection(sessionId),
  );
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * Every record this session has shown, so a chip survives a failed listing.
   *
   * State rather than a ref: it is read while rendering the chips, and a ref
   * read during render is a value React does not promise is current.
   */
  const [lastSeen, setLastSeen] = useState<readonly ResultReference[]>([]);

  if (selection.sessionId !== sessionId) {
    setSelection(initialSelection(sessionId));
    setAvailable([]);
    setError(null);
    // One conversation's records must never label another's chips.
    setLastSeen([]);
  }

  useEffect(() => {
    if (!sessionId) return;
    writeStoredSelection(sessionId, {
      selectedIds: selection.selectedIds,
      decided: selection.preselected,
      dismissed: selection.dismissed,
    });
  }, [
    sessionId,
    selection.selectedIds,
    selection.preselected,
    selection.dismissed,
  ]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void listSessionResults(sessionId)
      .then((results) => {
        if (cancelled) return;
        setAvailable(results);
        setError(null);
        setLastSeen((current) => {
          const byId = new Map(current.map((entry) => [entry.id, entry]));
          for (const result of results) byId.set(result.id, result);
          return [...byId.values()];
        });
        setSelection((current) => {
          if (current.sessionId !== sessionId) return current;
          // A selection whose result the session no longer offers is dropped:
          // sending it would be refused at the boundary anyway, and a chip for
          // something that cannot be attached is a lie on screen.
          const offered = new Set(results.map((result) => result.id));
          const kept = current.selectedIds.filter((id) => offered.has(id));
          const only = results.length === 1 ? results[0] : undefined;
          if (
            only &&
            !current.preselected &&
            kept.length === 0 &&
            !current.dismissed.includes(only.id)
          ) {
            return { ...current, selectedIds: [only.id], preselected: true };
          }
          return kept.length === current.selectedIds.length
            ? current
            : { ...current, selectedIds: kept };
        });
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        // The last-known list is kept. Clearing it emptied the chips while the
        // ids they stood for were still submitted, so the composer showed a
        // turn carrying nothing and sent one carrying a result.
        setError(
          failure instanceof Error
            ? `Results could not be refreshed: ${failure.message}`
            : "Results could not be refreshed.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadToken]);

  const select = useCallback((id: string) => {
    setSelection((current) => {
      if (current.selectedIds.includes(id)) return current;
      // Refused here rather than at Send. A turn built past the limit is one
      // the endpoint rejects, and the user has no way to see why from a
      // failing Send.
      if (current.selectedIds.length >= MAX_CONTEXT_RESULTS_PER_TURN) {
        return current;
      }
      return {
        ...current,
        // Choosing is a decision, so a later reload restores it rather than
        // preselecting over it.
        preselected: true,
        dismissed: current.dismissed.filter((entry) => entry !== id),
        selectedIds: [...current.selectedIds, id],
      };
    });
  }, []);

  const clear = useCallback((id: string) => {
    setSelection((current) => ({
      ...current,
      preselected: true,
      dismissed: current.dismissed.includes(id)
        ? current.dismissed
        : [...current.dismissed, id],
      selectedIds: current.selectedIds.filter((entry) => entry !== id),
    }));
  }, []);

  const clearAll = useCallback(() => {
    setSelection((current) => ({
      ...current,
      preselected: true,
      dismissed: [...new Set([...current.dismissed, ...current.selectedIds])],
      selectedIds: [],
    }));
  }, []);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);


  // The last record seen for a selected id, kept even when it has left the
  // current listing. A chip stands for something Send will carry, so it must
  // not vanish while the id behind it is still in the payload.
  const byId = new Map(lastSeen.map((result) => [result.id, result]));
  for (const result of available) byId.set(result.id, result);
  const selected = selection.selectedIds.flatMap((id) => {
    const result = byId.get(id);
    return result ? [result] : [];
  });

  return {
    available,
    selectedIds: selection.selectedIds,
    canSelectMore: selection.selectedIds.length < MAX_CONTEXT_RESULTS_PER_TURN,
    error,
    selected,
    select,
    clear,
    clearAll,
    refresh,
  };
}

/** How a result is named on a chip and in the picker. */
export function describeResult(result: ResultReference): string {
  return `${result.producer.label} result`;
}

/**
 * What tells two results from the same producer apart.
 *
 * One agent answering twice produced two results, and both were labelled
 * "Analyst result": the user had to guess which one they were attaching. The
 * brief distinguishes a run; the completion time distinguishes anything.
 */
export function describeResultDetail(result: ResultReference): string {
  const when = formatCompletedAt(result.completedAt);
  // What was asked, then how the answer opens, then the id. A timestamp alone
  // rounds to the minute, so two replies from one agent inside that minute
  // read identically, which is the case this exists for.
  const distinguishing =
    trimmedOrUndefined(result.brief) ??
    trimmedOrUndefined(result.excerpt) ??
    stableSuffix(result);
  return `${when} · ${
    distinguishing.length > 80
      ? `${distinguishing.slice(0, 79)}…`
      : distinguishing
  }`;
}

/**
 * Labels for a whole list, guaranteed distinct.
 *
 * Per-result text is not enough on its own: two replies to the same question
 * in the same minute, or two questions sharing their first 79 characters,
 * render identically however carefully each is composed. Anything that would
 * collide gains a stable suffix, so the labels stay readable in the ordinary
 * case and stay usable in the case that matters.
 */
export function describeResultDetails(
  results: readonly ResultReference[],
): Map<string, string> {
  const base = new Map(
    results.map((result) => [result.id, describeResultDetail(result)]),
  );
  const counts = new Map<string, number>();
  for (const detail of base.values()) {
    counts.set(detail, (counts.get(detail) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const result of results) {
    const detail = base.get(result.id) ?? "";
    labels.set(
      result.id,
      (counts.get(detail) ?? 0) > 1
        ? `${detail} · ${stableSuffix(result)}`
        : detail,
    );
  }
  return labels;
}

/** Short, derived from the durable id, and the same on every render. */
function stableSuffix(result: ResultReference): string {
  return `#${result.id.slice(-8)}`;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const single = value?.replace(/\s+/g, " ").trim();
  return single ? single : undefined;
}

function formatCompletedAt(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/**
 * The state a surface with no run results has.
 *
 * Exported so a caller that cannot carry results renders the same component
 * without a second code path through it.
 */
export const NO_CONTEXT_RESULTS: ContextResultsState = {
  available: [],
  selectedIds: [],
  canSelectMore: false,
  error: null,
  selected: [],
  select: () => {},
  clear: () => {},
  clearAll: () => {},
  refresh: () => {},
};
