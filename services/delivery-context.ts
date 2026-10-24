import path from "node:path";
import { createHash } from "node:crypto";
import { escapeUntrustedContent } from "../core/untrusted-content.js";

import { FileSystemRunStore } from "../domains/run/run-store.js";
import type {
  ChatDeliveryArtifact,
  ChatMessage,
} from "../contracts/sessions.js";

/**
 * Reads the text content of a delivered artifact, or null when it is missing
 * or not text (e.g. a .docx download, which RunStore returns as a Buffer).
 */
export type DeliveryArtifactReader = (
  runId: string,
  artifactPath: string,
) => Promise<string | null>;

/** Per-artifact cap so a large deliverable cannot flood the model context. */
export const MAX_DELIVERY_CONTEXT_CHARS = 8000;

const TEXT_LIKE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".csv",
  ".log",
  ".yaml",
  ".yml",
]);

export function createDeliveryArtifactReader(
  workspacePath: string,
): DeliveryArtifactReader {
  const store = new FileSystemRunStore(workspacePath);
  return async (runId, artifactPath) => {
    const result = await store
      .readArtifact(runId, artifactPath)
      .catch(() => null);
    return result && typeof result.content === "string"
      ? result.content
      : null;
  };
}

function isTextLikeArtifact(artifact: ChatDeliveryArtifact): boolean {
  if (TEXT_LIKE_EXTENSIONS.has(path.extname(artifact.path).toLowerCase())) {
    return true;
  }
  const mediaType = artifact.mediaType?.toLowerCase() ?? "";
  return mediaType.startsWith("text/") || mediaType.includes("json");
}

/**
 * One delivered artifact's text, or the reason there is none.
 *
 * Shared with the continuation block, which needs the same two outcomes told
 * apart: a run that produced a DOCX and a run whose artifact could not be read
 * are different facts, and both are different from a run that produced
 * nothing.
 */
export async function readDeliveryArtifactExcerpt(
  artifact: ChatDeliveryArtifact,
  readArtifact: DeliveryArtifactReader,
): Promise<{ text: string } | { unavailable: string }> {
  if (!isTextLikeArtifact(artifact)) {
    return { unavailable: "binary document, content not inlined" };
  }
  const content = await readArtifact(artifact.runId, artifact.path);
  if (content === null) return { unavailable: "content unavailable" };
  if (artifact.digest && createHash("sha256").update(content).digest("hex") !== artifact.digest) {
    return { unavailable: "published revision changed, content unavailable" };
  }
  return { text: content };
}

async function formatDeliveryArtifactBlock(
  artifact: ChatDeliveryArtifact,
  readArtifact: DeliveryArtifactReader,
): Promise<string> {
  const label = escapeUntrustedContent(artifact.title ?? artifact.path);
  const result = await readDeliveryArtifactExcerpt(artifact, readArtifact);
  if ("unavailable" in result) return `[Delivered file: ${label} — ${result.unavailable}]`;
  const content = result.text;
  const truncated = content.length > MAX_DELIVERY_CONTEXT_CHARS;
  const body = truncated
    ? `${content.slice(0, MAX_DELIVERY_CONTEXT_CHARS)}\n… (truncated)`
    : content;
  return `--- Delivered file: ${label} ---\n<delivered_file trust="untrusted_user_content">\n${escapeUntrustedContent(body)}\n</delivered_file>\n--- End of ${label} ---`;
}

/**
 * Returns `messages` with each delivery message's text augmented by the actual
 * delivered file contents, so chat models can answer questions about results.
 * Messages without a delivery pass through untouched, as does everything when
 * no reader is configured.
 */
export async function enrichHistoryWithDeliveryContent(
  messages: ChatMessage[],
  readArtifact: DeliveryArtifactReader | undefined,
): Promise<ChatMessage[]> {
  if (!readArtifact) return messages;
  const enriched: ChatMessage[] = [];
  for (const message of messages) {
    const artifacts = message.delivery?.artifacts;
    if (!artifacts || artifacts.length === 0) { enriched.push(message); continue; }
    const blocks: string[] = [];
    for (const artifact of artifacts) blocks.push(await formatDeliveryArtifactBlock(artifact, readArtifact));
    enriched.push({ ...message, text: `${message.text}\n\n${blocks.join("\n\n")}` });
  }
  return enriched;
}
