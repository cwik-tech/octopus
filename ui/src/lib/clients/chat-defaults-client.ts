import type { ModelChoice } from "@/lib/utils/model-catalog";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

function toUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const fallback = `${response.status} ${response.statusText}`;
  try {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error || fallback);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(fallback, { cause: error });
    }
    throw error;
  }
}

export interface ChatDefaults {
  workflow: ModelChoice;
  team: ModelChoice;
  agent: ModelChoice;
  run: ModelChoice;
  /** Whether this deployment ships the front door's persona. */
  frontDoorInstalled?: boolean;
}

export async function fetchChatDefaults(): Promise<ChatDefaults> {
  const response = await expectOk(await fetch(toUrl("/create/chat-defaults")));
  return (await response.json()) as ChatDefaults;
}
