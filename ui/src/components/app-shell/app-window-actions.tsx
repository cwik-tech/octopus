import { NewChatWindowMenu } from "./new-chat-window-menu";
import { Moon, PanelLeft, PanelRight, Plus, Settings, Sun } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { HeaderIconButton } from "@/components/sidebar/header-icon-button";

export function AppWindowActions({
  isLeftSidebarOpen,
  isSettingsOpen,
  isUsingDarkTheme,
  newActionDisabled,
  newActionLabel,
  onNewAction,
  onOpenSettings,
  onRightSidebarToggle,
  rightSidebarDisabled,
  rightSidebarLabel,
  rightSidebarOpen,
  rightSidebarVisible = true,
  setLeftSidebarOpen,
  toggleTheme,
  shortcutKeys,
}: {
  isLeftSidebarOpen: boolean;
  isSettingsOpen: boolean;
  isUsingDarkTheme: boolean;
  newActionDisabled: boolean;
  newActionLabel: string;
  onNewAction: () => void;
  onOpenSettings: () => void;
  onRightSidebarToggle: () => void;
  rightSidebarDisabled: boolean;
  rightSidebarLabel: string;
  rightSidebarOpen: boolean;
  rightSidebarVisible?: boolean;
  setLeftSidebarOpen: Dispatch<SetStateAction<boolean>>;
  shortcutKeys: string[];
  toggleTheme: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 h-11">
      <div
        aria-label="Left window actions"
        className="desktop-window-actions pointer-events-auto absolute inset-y-0 left-21.5 flex items-center gap-1"
        role="group"
      >
        <HeaderIconButton
          label={isLeftSidebarOpen ? "Hide sidebar" : "Show sidebar"}
          active={isLeftSidebarOpen}
          onClick={() => setLeftSidebarOpen((value) => !value)}
          keys={[...shortcutKeys, "B"]}
        >
          <PanelLeft className="size-4" />
        </HeaderIconButton>
        <NewChatWindowMenu enabled={newActionLabel === "New chat"}>
          <HeaderIconButton
            label={newActionLabel}
            disabled={newActionDisabled}
            onClick={onNewAction}
          >
            <Plus className="size-4" />
          </HeaderIconButton>
        </NewChatWindowMenu>
      </div>
      <div
        aria-label="Right window actions"
        className="desktop-window-actions pointer-events-auto absolute inset-y-0 right-2 flex items-center gap-1"
        role="group"
      >
        {rightSidebarVisible ? (
          <HeaderIconButton
            label={rightSidebarLabel}
            active={rightSidebarOpen}
            disabled={rightSidebarDisabled}
            onClick={onRightSidebarToggle}
            keys={[...shortcutKeys, "."]}
          >
            <PanelRight className="size-4" />
          </HeaderIconButton>
        ) : null}
        <HeaderIconButton
          label={isUsingDarkTheme ? "Use light mode" : "Use dark mode"}
          onClick={toggleTheme}
        >
          {isUsingDarkTheme ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </HeaderIconButton>
        <HeaderIconButton
          label="Settings"
          active={isSettingsOpen}
          onClick={onOpenSettings}
        >
          <Settings className="size-4" />
        </HeaderIconButton>
      </div>
    </div>
  );
}
