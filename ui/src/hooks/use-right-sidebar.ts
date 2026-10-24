import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ElementRef,
  type RefObject,
} from "react";

import type { WorkspaceRightSidebarControls } from "@/components/sidebar/workspace-right-sidebar-controls";
import type { RunTargetLockReason, RunWorkspaceView } from "@/components/run/run-panel";
import { ResizablePanel } from "@/components/ui/resizable";
import type { NavigationTab } from "@/lib/utils/app-navigation";

export const DEFAULT_RIGHT_SIDEBAR_SIZE = 32;
export const MIN_RIGHT_SIDEBAR_SIZE = 26;
export const MAX_RIGHT_SIDEBAR_SIZE = 52;
const RIGHT_SIDEBAR_SIZE_STORAGE_KEY = "pipeline-right-sidebar-size";

function readStoredRightSidebarSize(): number {
  if (typeof localStorage === "undefined") return DEFAULT_RIGHT_SIDEBAR_SIZE;
  const stored = Number(localStorage.getItem(RIGHT_SIDEBAR_SIZE_STORAGE_KEY));
  if (!Number.isFinite(stored)) return DEFAULT_RIGHT_SIDEBAR_SIZE;
  return Math.min(
    Math.max(stored, MIN_RIGHT_SIDEBAR_SIZE),
    MAX_RIGHT_SIDEBAR_SIZE,
  );
}

export function useRightSidebar({
  activeTab,
  runTargetLockReason = null,
  createInspectorOpen,
  setCreateInspectorOpen,
  headerRef,
  workspaceSidebar = null,
}: {
  workspaceSidebar?: WorkspaceRightSidebarControls | null;
  activeTab: NavigationTab;
  runWorkspaceView: RunWorkspaceView;
  runInspectorOpen: boolean;
  runTargetLockReason?: RunTargetLockReason | null;
  createInspectorOpen: boolean;
  setRunInspectorOpen: (open: boolean) => void;
  setCreateInspectorOpen: (open: boolean) => void;
  headerRef: RefObject<HTMLElement | null>;
}) {
  const [rightSidebarTarget, setRightSidebarTarget] =
    useState<HTMLDivElement | null>(null);
  const rightSidebarPanelRef =
    useRef<ElementRef<typeof ResizablePanel>>(null);
  const [initialRightSidebarSize] = useState(readStoredRightSidebarSize);
  const lastRightSidebarSizeRef = useRef(initialRightSidebarSize);

  const runSidebarAvailable = activeTab === "run" && workspaceSidebar !== null;
  const rightSidebarAvailable = activeTab === "create" || runSidebarAvailable;
  const rightSidebarOpen = activeTab === "create" ? createInspectorOpen : runSidebarAvailable && workspaceSidebar.open;
  const rightSidebarDisabled = !rightSidebarAvailable;
  const rightSidebarLabel =
    activeTab === "create"
      ? rightSidebarOpen
        ? "Hide details"
        : "Show details"
      : activeTab === "run" && !runSidebarAvailable && runTargetLockReason !== null
        ? runTargetLockReason === "scheduled-research"
          ? "Scheduled research in progress"
          : "Team is fixed for this session"
        : rightSidebarOpen
          ? "Hide inspector"
          : "Show inspector";

  const handleRightSidebarOpenChange = useCallback(
    (open: boolean) => {
      if (!rightSidebarAvailable || open === rightSidebarOpen) return;
      if (runSidebarAvailable) workspaceSidebar.onOpenChange(open);
      else setCreateInspectorOpen(open);
    },
    [
      rightSidebarAvailable,
      rightSidebarOpen,
      runSidebarAvailable,
      workspaceSidebar,
      setCreateInspectorOpen,
    ],
  );

  const handleRightSidebarToggle = useCallback(() => {
    if (!rightSidebarAvailable) return;
    handleRightSidebarOpenChange(!rightSidebarOpen);
  }, [handleRightSidebarOpenChange, rightSidebarAvailable, rightSidebarOpen]);

  const handleRightSidebarResize = useCallback((size: number) => {
    if (size <= 0) return;
    lastRightSidebarSizeRef.current = size;
    localStorage.setItem(RIGHT_SIDEBAR_SIZE_STORAGE_KEY, String(size));
  }, []);

  const previousRightSidebarOpenRef = useRef(rightSidebarOpen);

  useEffect(() => {
    if (previousRightSidebarOpenRef.current === rightSidebarOpen) return;
    previousRightSidebarOpenRef.current = rightSidebarOpen;
    if (headerRef.current?.getBoundingClientRect().width === 0) return;

    const timeoutId = window.setTimeout(() => {
      const panel = rightSidebarPanelRef.current;
      if (!panel) return;
      if (rightSidebarOpen) {
        panel.resize(lastRightSidebarSizeRef.current);
      } else {
        panel.collapse();
      }
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [headerRef, rightSidebarOpen]);

  return {
    rightSidebarTarget,
    setRightSidebarTarget,
    rightSidebarPanelRef,
    initialRightSidebarSize,
    rightSidebarAvailable,
    rightSidebarOpen,
    rightSidebarDisabled,
    rightSidebarLabel,
    handleRightSidebarOpenChange,
    handleRightSidebarToggle,
    handleRightSidebarResize,
  };
}

export type RightSidebarController = ReturnType<typeof useRightSidebar>;
