import type { SessionMessageDispatchResponse } from "@/lib/models/session-model";

export const FOLDER_TOOLS_UNAVAILABLE_NOTICE =
  "This model can see folder names but can't open files. Use a model with tool support to work with folder contents.";

/**
 * What a turn says about the chat's folder tools notice
 * (docs/feature-local-folder-access.md, "Models that can't use tools").
 *
 * `true` when a reply ran without tools while folders were attached, which the
 * server marks on that reply. `false` when the turn has a reply that ran and
 * carries no such mark, because that reply could use its tools or had no
 * folders to open. `undefined` when the turn says nothing either way: a Team
 * dispatch, a single-answer turn, or replies that all failed.
 */
export function folderToolsNoticeAfter(
  response: SessionMessageDispatchResponse,
): boolean | undefined {
  if (!("meta" in response) || !("replies" in response.meta)) return undefined;
  const { replies } = response.meta;
  if (replies.some((reply) => reply.folderToolsUnavailable === true)) return true;
  if (replies.some((reply) => !reply.fallback)) return false;
  return undefined;
}
