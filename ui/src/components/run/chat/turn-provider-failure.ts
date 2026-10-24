import type { SessionMessageDispatchResponse } from "@/lib/models/session-model";

/**
 * Whether this turn ended because a provider refused it.
 *
 * A turn that dies on an exhausted key does not throw. It returns an ordinary
 * response carrying a safe apology in place of an answer, which is why the
 * badges beside it went on saying the agent was available until the user
 * navigated away and back. `fallback` is the server's own word for "this reply
 * is the failure, not the model's": it is already set where the provider error
 * is caught, so nothing new has to be recorded to notice it here.
 *
 * A Team dispatch carries no reply meta — it starts durable work whose failures
 * surface through the task, not through this response — so it reports nothing
 * rather than having its silence read as a failure.
 */
export function turnReportedProviderFailure(
  response: SessionMessageDispatchResponse,
): boolean {
  if (!("meta" in response) || !response.meta) return false;
  const { meta } = response;
  return "replies" in meta
    ? meta.replies.some((reply) => reply.fallback)
    : meta.fallback;
}
