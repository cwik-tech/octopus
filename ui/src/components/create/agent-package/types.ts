import type {
  AgentDetail,
  AgentPackageAddKind,
  AgentPackageFileInput,
  AgentPackageImportChoice,
  AgentPackageImportItem,
  AgentPackageRemoveMode,
} from "@/lib/models/agent-generator-model";

export interface AgentPackageEditorProps {
  agentName: string | null;
  agentDetail: AgentDetail | null;
  personaMarkdown: string | null;
  /** Last saved/loaded persona markdown, used to highlight unsaved changes. */
  savedPersonaMarkdown: string | null;
  onPersonaChange: (value: string) => void;
  dirty: boolean;
  saving: boolean;
  saved: { personaPath: string } | null;
  saveError: string | null;
  /**
   * Writes the persona. Without an argument it saves the markdown on screen;
   * with one it saves that markdown, for a change that has not reached the
   * `personaMarkdown` prop yet.
   */
  onSave: (personaMarkdown?: string) => void | Promise<void>;
  onRevealAsset: (path: string) => void | Promise<void>;
  onPreviewPackageImport: (
    kind: AgentPackageAddKind,
    files: AgentPackageFileInput[],
  ) => Promise<AgentPackageImportItem[]>;
  onCommitPackageImport: (
    kind: AgentPackageAddKind,
    files: AgentPackageFileInput[],
    choices: AgentPackageImportChoice[],
  ) => void | Promise<void>;
  onRemovePackageItem: (
    kind: AgentPackageAddKind,
    agentPath: string,
    mode: AgentPackageRemoveMode,
  ) => void | Promise<void>;
  /** A way back to whatever opened this agent, shown before its name. */
  back?: { label: string; onClick: () => void } | undefined;
  className?: string;
}

export interface PendingRemoval {
  kind: AgentPackageAddKind;
  agentPath: string;
  label: string;
}

export interface ImportDraft {
  kind: AgentPackageAddKind;
  files: AgentPackageFileInput[];
  items: AgentPackageImportItem[];
}
