import { resourceArchitectConversationSchema } from "@contracts/schemas/resource-architect-conversation";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const endpoint = `${getApiBaseUrl()}/create/resource-architect/conversation`;

export class ResourceArchitectConnectionError extends Error {
  constructor(cause: unknown) {
    super("Connection interrupted. Checking your request…", { cause });
    this.name = "ResourceArchitectConnectionError";
  }
}

export async function readResourceArchitectConversation(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(endpoint, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  // Compatibility with servers predating conversation persistence.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("The saved Create conversation could not be restored.");
  const value: unknown = await response.json();
  return resourceArchitectConversationSchema.nullable().parse(value);
}

export async function clearResourceArchitectConversation() {
  const response = await fetch(endpoint, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
  if (!response.ok && response.status !== 404) throw new Error("The Create conversation could not be cleared. Try New again.");
}
