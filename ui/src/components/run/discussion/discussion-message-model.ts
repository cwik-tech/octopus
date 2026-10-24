/**
 * `crypto-investment-lead-2026-05-01-12-00.md` — speaker first so a folder of
 * saved responses sorts by who said it, then the minute so two answers from
 * the same agent never overwrite each other. Unusable parts drop out rather
 * than producing `undefined` in a filename.
 */
export function messageMarkdownFileName(
  speakerName: string,
  createdAt: string,
): string {
  const slug = speakerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const date = new Date(createdAt);
  const stamp = Number.isNaN(date.getTime())
    ? ""
    : date.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const name = [slug, stamp].filter(Boolean).join("-");
  return `${name || "response"}.md`;
}
