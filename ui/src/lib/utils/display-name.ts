const DISPLAY_NAME_SEPARATORS = /[-_\s]+/;

/**
 * Converts persisted resource identifiers into UI labels without changing the
 * identifier used by API calls, selection state, or storage.
 */
export function formatDisplayName(value: string): string {
  return value
    .trim()
    .split(DISPLAY_NAME_SEPARATORS)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
