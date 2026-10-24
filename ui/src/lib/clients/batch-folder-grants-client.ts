import type { BatchApiError, BatchFolderGrantView } from "@contracts/batches";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export async function listBatchFolderGrants(): Promise<BatchFolderGrantView[]> {
  const response = await request<{ grants: BatchFolderGrantView[] }>({ method: "GET" });
  return response.grants;
}

export async function revokeBatchFolderGrant(path: string): Promise<void> {
  await request<void>({
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

async function request<T>(init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/settings/batch-folder-grants`, init);
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  const payload = await response.json().catch(() => ({})) as Partial<BatchApiError>;
  throw new Error(
    typeof payload.error === "string"
      ? payload.error
      : `${response.status} ${response.statusText || "Batch folder request failed"}`,
  );
}
