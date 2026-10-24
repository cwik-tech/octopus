import { useState } from "react";

import type {
  AgentPackageAddKind,
  AgentPackageFileInput,
  AgentPackageImportChoice,
  AgentPackageImportItem,
  AgentPackageRemoveMode,
} from "@/lib/models/agent-generator-model";
import type { ImportDraft, PendingRemoval } from "./types";

interface AgentPackageActionOptions {
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
}

export function useAgentPackageActions(options: AgentPackageActionOptions) {
  const [revealError, setRevealError] = useState<string | null>(null);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageBusyKey, setPackageBusyKey] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [importChoices, setImportChoices] = useState<
    Record<string, AgentPackageImportChoice>
  >({});

  async function runPackageAction(
    key: string,
    action: () => void | Promise<void>,
  ) {
    setPackageBusyKey(key);
    setPackageError(null);
    setRevealError(null);
    try {
      await action();
    } catch (error) {
      setPackageError(error instanceof Error ? error.message : String(error));
    } finally {
      setPackageBusyKey(null);
    }
  }

  async function startImport(
    kind: AgentPackageAddKind,
    files: AgentPackageFileInput[],
  ) {
    await runPackageAction(`preview:${kind}`, async () => {
      const items = await options.onPreviewPackageImport(kind, files);
      const needsReview = items.some(
        (item) =>
          item.exists ||
          item.kind !== kind ||
          item.parentSkill !== undefined ||
          !item.defaultSelected,
      );
      if (!needsReview) {
        await options.onCommitPackageImport(
          kind,
          files,
          items.map((item) => ({
            id: item.id,
            selected: true,
            action: item.defaultAction,
          })),
        );
        return;
      }
      setImportDraft({ kind, files, items });
      setImportChoices(
        Object.fromEntries(
          items.map((item) => [
            item.id,
            {
              id: item.id,
              selected: item.defaultSelected,
              action: item.defaultAction,
            },
          ]),
        ),
      );
    });
  }

  async function confirmImport() {
    if (!importDraft) return;
    await runPackageAction(`import:${importDraft.kind}`, async () => {
      await options.onCommitPackageImport(
        importDraft.kind,
        importDraft.files,
        Object.values(importChoices),
      );
      setImportDraft(null);
      setImportChoices({});
    });
  }

  async function confirmRemoval(mode: AgentPackageRemoveMode) {
    if (!pendingRemoval) return;
    await runPackageAction(
      `remove:${pendingRemoval.kind}:${pendingRemoval.agentPath}`,
      async () => {
        await options.onRemovePackageItem(
          pendingRemoval.kind,
          pendingRemoval.agentPath,
          mode,
        );
        setPendingRemoval(null);
      },
    );
  }

  async function revealAsset(path: string) {
    setRevealError(null);
    try {
      await options.onRevealAsset(path);
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : String(error));
    }
  }

  function closeImport() {
    setImportDraft(null);
    setImportChoices({});
  }

  function updateImportChoice(choice: AgentPackageImportChoice) {
    setImportChoices((current) => ({ ...current, [choice.id]: choice }));
  }

  return {
    revealError,
    packageError,
    packageBusyKey,
    pendingRemoval,
    importDraft,
    importChoices,
    startImport,
    confirmImport,
    confirmRemoval,
    revealAsset,
    requestRemoval: setPendingRemoval,
    closeRemoval: () => setPendingRemoval(null),
    closeImport,
    updateImportChoice,
  };
}
