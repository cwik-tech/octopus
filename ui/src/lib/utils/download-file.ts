/**
 * Save text the browser never fetched.
 *
 * A chat response only exists in memory, so there is no artifact URL an anchor
 * can point at the way delivery cards do. The text is wrapped in a blob and
 * handed over through a synthetic click. Chromium takes the blob during that
 * click, so the object URL is released as soon as the click returns rather
 * than being left to leak for the life of the window.
 */
export function downloadTextFile(
  fileName: string,
  text: string,
  type = "text/markdown;charset=utf-8",
): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
