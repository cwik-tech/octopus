import { useEffect, type Dispatch, type SetStateAction } from "react";

export function useSidebarShortcuts({
  rightSidebarAvailable,
  rightSidebarOpen,
  onRightSidebarOpenChange,
  setLeftSidebarOpen,
}: {
  rightSidebarAvailable: boolean;
  rightSidebarOpen: boolean;
  onRightSidebarOpenChange: (open: boolean) => void;
  setLeftSidebarOpen: Dispatch<SetStateAction<boolean>>;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      const active = document.activeElement;
      if (
        active?.tagName === "INPUT" ||
        active?.tagName === "TEXTAREA" ||
        (active as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }
      if (key === "b") {
        event.preventDefault();
        setLeftSidebarOpen((value) => !value);
        return;
      }
      if (key === ".") {
        if (!rightSidebarAvailable) return;
        event.preventDefault();
        onRightSidebarOpenChange(!rightSidebarOpen);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    onRightSidebarOpenChange,
    rightSidebarAvailable,
    rightSidebarOpen,
    setLeftSidebarOpen,
  ]);
}
