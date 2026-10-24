import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { RunTargetLockReason, RunWorkspaceView } from "@/components/run/run-panel";
import { useBatches } from "@/components/batch/use-batches";
import { useSchedulingQueue } from "@/components/run/queue/use-scheduling-queue";
import { useSchedules } from "@/components/schedule/use-schedules";
import { useSidebarSessions } from "@/hooks/use-sidebar-sessions";
import type { NavigationTab } from "@/lib/utils/app-navigation";

export function useRunWorkspaceController({
  activeTab,
  setActiveTab,
  setLeftSidebarOpen,
}: {
  activeTab: NavigationTab;
  setActiveTab: Dispatch<SetStateAction<NavigationTab>>;
  setLeftSidebarOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [runTargetLockReason, setRunTargetLockReason] = useState<RunTargetLockReason | null>(null);
  const [createSessionAction, setCreateSessionAction] = useState<
    (() => void) | null
  >(null);
  // Nothing here creates a session any more, so the New action is never in a
  // pending state. Kept as a constant because the titlebar still asks.
  const isCreatingSession = false;
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [selectionRequest, setSelectionRequest] = useState<{
    id: string;
    requestId: string;
  } | null>(null);
  const [deletionRequest, setDeletionRequest] = useState<{
    id: string;
    requestId: string;
  } | null>(null);
  const [workspaceView, setWorkspaceView] =
    useState<RunWorkspaceView>("session");
  const activityCollapsedSessionsRef = useRef<Set<string>>(new Set());
  const sessions = useSidebarSessions();
  const queue = useSchedulingQueue(activeTab === "run");
  const schedules = useSchedules(activeTab === "run");
  const batches = useBatches(activeTab === "run");

  const registerCreateSessionAction = useCallback(
    (action: (() => void) | null) => {
      setCreateSessionAction(() => action);
    },
    [],
  );

  /**
   * New opens an empty conversation. Nothing is written until the user does
   * something with it, so there is no create here and no fallback that would
   * persist one: when the Run panel is not mounted, switching to it is enough,
   * because it mounts on a fresh draft of its own.
   */
  const createSidebarSession = useCallback(async () => {
    setActiveTab("run");
    setWorkspaceView("session");
    // Clear any standing selection, so mounting the Run panel lands on its
    // draft rather than re-opening the session that was last selected.
    setSelectedSessionId(null);
    setSelectionRequest(null);
    createSessionAction?.();
  }, [createSessionAction, setActiveTab]);

  const selectSession = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      setSelectionRequest({ id: sessionId, requestId: crypto.randomUUID() });
      setActiveTab("run");
      setWorkspaceView("session");
    },
    [setActiveTab],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      selectSession(sessionId);
      setInspectorOpen(true);
    },
    [selectSession],
  );

  const selectQueue = useCallback(() => {
    setActiveTab("run");
    setWorkspaceView("queue");
  }, [setActiveTab]);

  const selectSchedules = useCallback(() => {
    setActiveTab("run");
    setWorkspaceView("schedule");
  }, [setActiveTab]);

  const reportSessionActivity = useCallback(
    (sessionId: string) => {
      if (activityCollapsedSessionsRef.current.has(sessionId)) return;
      activityCollapsedSessionsRef.current.add(sessionId);
      setLeftSidebarOpen(false);
      setInspectorOpen(false);
    },
    [setLeftSidebarOpen],
  );

  return {
    createSidebarSession,
    batches,
    deletionRequest,
    inspectorOpen,
    runTargetLockReason,
    isCreatingSession,
    openSession,
    queue,
    registerCreateSessionAction,
    reportSessionActivity,
    schedules,
    selectQueue,
    selectSchedules,
    selectSession,
    selectedSessionId,
    selectionRequest,
    sessions,
    setDeletionRequest,
    setInspectorOpen,
    setRunTargetLockReason,
    setSelectionRequest,
    setSelectedSessionId,
    workspaceView,
  };
}

export type RunWorkspaceController = ReturnType<
  typeof useRunWorkspaceController
>;
