// Encode every Unicode code point so distinct timeline keys cannot collapse to
// the same DOM id after punctuation replacement.
const encodeAnchorSegment = (value: string): string =>
  Array.from(value, (character) =>
    character.codePointAt(0)?.toString(16).padStart(4, "0"),
  ).join("-");

/** Stable DOM anchor id for the card rendered for a timeline item key. */
export function fileCardAnchorId(key: string): string {
  return `file-card-${encodeAnchorSegment(key)}`;
}

export function scrollToFileCard(key: string): void {
  document
    .getElementById(fileCardAnchorId(key))
    ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
