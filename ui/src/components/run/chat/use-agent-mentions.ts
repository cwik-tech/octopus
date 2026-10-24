import {
  startTransition,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";

import type { SessionMessageTarget } from "@contracts/schemas/session-requests";
import { listAgents } from "@/lib/clients/agent-generator-client";
import type { AgentSummary } from "@/lib/models/agent-generator-model";
import type { ChatMessage } from "@/lib/models/session-model";
import {
  findActiveAgentMention,
  insertAgentMention,
  type ActiveAgentMention,
} from "@/lib/utils/agent-mentions";
import { formatDisplayName } from "@/lib/utils/display-name";

/**
 * What the mention hook reads from its panel.
 *
 * Every key is required, so a call site that leaves one out fails the type
 * check.
 */
export interface AgentMentionsInput {
  /** A change closes the open list. */
  sessionId: string | null;
  target: SessionMessageTarget | undefined;
  /** The Team this turn is addressed to. When set, only its roster is offered. */
  targetTeamId: string | null;
  teamMemberNames: readonly string[];
  /** The transcript on screen. Its Agent speakers are listed first. */
  displayedMessages: readonly ChatMessage[];
  /** The composer textarea. A pick is written into it and focuses it. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

/** The Agent catalog the submit resolves mentions against. */
export interface AgentMentionCatalog {
  agents: AgentSummary[];
  /** True once the catalog has loaded; false while loading and after a failure. */
  ready: boolean;
  /** Why the catalog failed to load, or null. */
  error: string | null;
  loading: boolean;
  /** Asks for the catalog again if its last request failed; otherwise does nothing. */
  retry: () => void;
}

/** The mention entries of the composer textarea's props. */
export interface AgentMentionTextareaProps {
  "aria-autocomplete": "list";
  "aria-controls": string | undefined;
  "aria-expanded": boolean;
  "aria-activedescendant": string | undefined;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLTextAreaElement>) => void;
  onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) => void;
  onKeyUp: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}

/** The suggestion list: the Popover's open state and the menu's props. */
export interface AgentMentionMenuState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeIndex: number;
  agents: AgentSummary[];
  error: string | null;
  participatingAgentKeys: ReadonlySet<string>;
  listboxId: string;
  loading: boolean;
  query: string;
  onActiveIndexChange: (index: number) => void;
  onQueryChange: (query: string) => void;
  onKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) => void;
  onSelect: (agent: AgentSummary) => void;
}

export interface AgentMentions {
  /** The same object until one of its fields changes. */
  catalog: AgentMentionCatalog;
  textareaProps: AgentMentionTextareaProps;
  menu: AgentMentionMenuState;
}

/**
 * The composer's @-mentions: the Agent catalog, the token under the caret,
 * the suggestion list and the insertion of a pick.
 */
export function useAgentMentions({
  sessionId,
  target,
  targetTeamId,
  teamMemberNames,
  displayedMessages,
  textareaRef,
}: AgentMentionsInput): AgentMentions {
  const [mentionAgents, setMentionAgents] = useState<AgentSummary[]>([]);
  const [mentionAgentsLoading, setMentionAgentsLoading] = useState(false);
  const [mentionAgentsError, setMentionAgentsError] = useState<string | null>(null);
  const [mentionAgentsReady, setMentionAgentsReady] = useState(false);
  const mentionAgentsCacheRef = useRef<AgentSummary[] | null>(null);
  const mentionAgentsRequestRef = useRef<Promise<AgentSummary[]> | null>(null);
  /** Bumped to request the catalog again after a failure. */
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  /** True only while the latest catalog request has failed and none is under way. */
  const catalogFailedRef = useRef(false);
  const retryCatalog = useCallback(() => {
    if (!catalogFailedRef.current) return;
    catalogFailedRef.current = false;
    setCatalogAttempt((attempt) => attempt + 1);
  }, []);
  const [activeMention, setActiveMention] = useState<ActiveAgentMention | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const mentionDismissedRef = useRef(false);
  const mentionListboxId = useId();
  const participatingAgentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const message of displayedMessages) {
      if (message.speaker?.type !== "agent") continue;
      keys.add(mentionAgentIdentityKey(message.speaker.id));
      keys.add(mentionAgentIdentityKey(message.speaker.name));
    }
    const selectedNames = target?.kind === "agents"
      ? target.agentNames
      : targetTeamId ? teamMemberNames : [];
    for (const name of selectedNames) keys.add(mentionAgentIdentityKey(name));
    return keys;
  }, [displayedMessages, target, targetTeamId, teamMemberNames]);
  const mentionSuggestionAgents = useMemo(
    () =>
      mentionAgents.filter((agent) =>
        targetTeamId
          ? teamMemberNames.some(
              (name) =>
                mentionAgentIdentityKey(name) === mentionAgentIdentityKey(agent.name),
            )
          : true,
      ).sort((left, right) =>
        Number(participatingAgentKeys.has(mentionAgentIdentityKey(right.name))) -
        Number(participatingAgentKeys.has(mentionAgentIdentityKey(left.name))),
      ),
    [mentionAgents, participatingAgentKeys, targetTeamId, teamMemberNames],
  );
  const filteredMentionAgents = useMemo(() => {
    if (!activeMention) return [];
    const needle = mentionQuery.trim().toLowerCase();
    if (!needle) return mentionSuggestionAgents;
    return mentionSuggestionAgents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(needle) ||
        formatDisplayName(agent.name).toLowerCase().includes(needle),
    );
  }, [activeMention, mentionQuery, mentionSuggestionAgents]);
  const boundedActiveMentionIndex = Math.min(
    activeMentionIndex,
    Math.max(filteredMentionAgents.length - 1, 0),
  );
  const activeMentionAgent = filteredMentionAgents[boundedActiveMentionIndex];
  const activeMentionOptionId = activeMentionAgent
    ? `${mentionListboxId}-option-${boundedActiveMentionIndex}`
    : undefined;

  useEffect(() => {
    const cachedAgents = mentionAgentsCacheRef.current;
    if (cachedAgents) {
      startTransition(() => {
        setMentionAgents(cachedAgents);
        setMentionAgentsLoading(false);
        setMentionAgentsError(null);
        setMentionAgentsReady(true);
      });
      return;
    }

    let cancelled = false;
    startTransition(() => {
      setMentionAgentsLoading(true);
      setMentionAgentsError(null);
      setMentionAgentsReady(false);
    });
    const request = mentionAgentsRequestRef.current ?? listAgents();
    mentionAgentsRequestRef.current = request;
    void request
      .then((agents) => {
        mentionAgentsCacheRef.current = agents;
        if (mentionAgentsRequestRef.current === request) {
          mentionAgentsRequestRef.current = null;
        }
        if (cancelled) return;
        startTransition(() => {
          setMentionAgents(agents);
          setMentionAgentsLoading(false);
          setMentionAgentsReady(true);
        });
      })
      .catch((cause) => {
        if (mentionAgentsRequestRef.current === request) {
          mentionAgentsRequestRef.current = null;
        }
        if (cancelled) return;
        catalogFailedRef.current = true;
        startTransition(() => {
          setMentionAgents([]);
          setMentionAgentsError(
            cause instanceof Error ? cause.message : String(cause),
          );
          setMentionAgentsLoading(false);
          setMentionAgentsReady(false);
        });
      });
    return () => {
      cancelled = true;
    };
    // Runs again on each retry: a failed catalog is asked for again the next
    // time it is needed, instead of blocking mentions until the panel remounts.
  }, [catalogAttempt]);

  useEffect(() => {
    startTransition(() => {
      setActiveMention(null);
      setActiveMentionIndex(0);
    });
  }, [sessionId]);

  const updateActiveMention = useCallback(
    (textarea: HTMLTextAreaElement) => {
      mentionDismissedRef.current = false;
      const nextMention = findActiveAgentMention(
        textarea.value,
        textarea.selectionStart ?? textarea.value.length,
      );
      // The list needs the catalog; a failed one is asked for again here.
      if (nextMention) retryCatalog();
      setActiveMention(nextMention);
      setMentionQuery(nextMention?.query ?? "");
      setActiveMentionIndex(0);
    },
    [retryCatalog],
  );

  const selectMentionAgent = useCallback(
    (agent: AgentSummary) => {
      const textarea = textareaRef.current;
      if (!textarea || !activeMention) return;
      const inserted = insertAgentMention(
        textarea.value,
        activeMention,
        agent.name,
      );
      textarea.value = inserted.text;
      mentionDismissedRef.current = true;
      textarea.focus();
      textarea.setSelectionRange(inserted.cursor, inserted.cursor);
      setActiveMention(null);
      setActiveMentionIndex(0);
    },
    [activeMention, textareaRef],
  );

  const handleComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (!activeMention || event.nativeEvent.isComposing) {
        return;
      }
      if (event.key === "ArrowDown") {
        if (filteredMentionAgents.length === 0) return;
        event.preventDefault();
        setActiveMentionIndex((current) =>
          (current + 1) % filteredMentionAgents.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        if (filteredMentionAgents.length === 0) return;
        event.preventDefault();
        setActiveMentionIndex((current) =>
          (current - 1 + filteredMentionAgents.length) %
            filteredMentionAgents.length,
        );
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && activeMentionAgent) {
        event.preventDefault();
        selectMentionAgent(activeMentionAgent);
        return;
      }
      if (event.key === "Enter") {
        if (event.currentTarget instanceof HTMLInputElement) {
          event.preventDefault();
          return;
        }
        setActiveMention(null);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        mentionDismissedRef.current = true;
        setActiveMention(null);
        textareaRef.current?.focus();
      }
    },
    [
      activeMention,
      activeMentionAgent,
      filteredMentionAgents.length,
      selectMentionAgent,
      textareaRef,
    ],
  );

  const handleComposerKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        updateActiveMention(event.currentTarget);
      }
    },
    [updateActiveMention],
  );

  const catalog = useMemo<AgentMentionCatalog>(
    () => ({
      agents: mentionAgents,
      ready: mentionAgentsReady,
      error: mentionAgentsError,
      loading: mentionAgentsLoading,
      retry: retryCatalog,
    }),
    [mentionAgents, mentionAgentsReady, mentionAgentsError, mentionAgentsLoading, retryCatalog],
  );

  return {
    catalog,
    textareaProps: {
      "aria-autocomplete": "list",
      "aria-controls": activeMention ? mentionListboxId : undefined,
      "aria-expanded": Boolean(activeMention),
      "aria-activedescendant": activeMentionOptionId,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
        updateActiveMention(event.currentTarget),
      onClick: (event) => updateActiveMention(event.currentTarget),
      onSelect: (event) => {
        // Restoring focus after dismissal fires a selection event.
        // Wait for typing, a click, or caret movement to reopen.
        if (!mentionDismissedRef.current)
          updateActiveMention(event.currentTarget);
      },
      onKeyDown: handleComposerKeyDown,
      onKeyUp: handleComposerKeyUp,
    },
    menu: {
      open: Boolean(activeMention),
      onOpenChange: (open) => {
        if (!open) {
          mentionDismissedRef.current = true;
          setActiveMention(null);
        }
      },
      activeIndex: boundedActiveMentionIndex,
      agents: filteredMentionAgents,
      error: mentionAgentsError,
      participatingAgentKeys,
      listboxId: mentionListboxId,
      loading: mentionAgentsLoading,
      query: mentionQuery,
      onActiveIndexChange: setActiveMentionIndex,
      onQueryChange: (query) => {
        setMentionQuery(query);
        setActiveMentionIndex(0);
      },
      onKeyDown: handleComposerKeyDown,
      onSelect: selectMentionAgent,
    },
  };
}

export function mentionAgentIdentityKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}
