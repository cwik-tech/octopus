export type DeleteConfirmationPreference = "run-session";

const STORAGE_KEY_PREFIX = "pipeline-delete-confirmation.skip.";

interface DeleteConfirmationStorage {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

function storageKey(preference: DeleteConfirmationPreference): string {
  return `${STORAGE_KEY_PREFIX}${preference}`;
}

function getStorage(): DeleteConfirmationStorage | null {
  if (typeof localStorage === "undefined") return null;
  const storage = localStorage as Partial<DeleteConfirmationStorage>;
  return typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
    ? (storage as DeleteConfirmationStorage)
    : null;
}

export function shouldConfirmDelete(
  preference: DeleteConfirmationPreference,
): boolean {
  return getStorage()?.getItem(storageKey(preference)) !== "true";
}

export function setDeleteConfirmationSkipped(
  preference: DeleteConfirmationPreference,
  skipped: boolean,
): void {
  const storage = getStorage();
  if (!storage) return;

  if (skipped) {
    storage.setItem(storageKey(preference), "true");
    return;
  }

  storage.removeItem(storageKey(preference));
}
