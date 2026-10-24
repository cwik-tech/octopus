/**
 * The document formats an upload surface offers, stated once for every layer that has an opinion.
 *
 * Four places used to answer this question independently: the renderer's `accept` attribute, the
 * project store's allow-list, the team store's allow-list, and the sentence each route writes into
 * its 400. When they disagreed the user met the worst possible shape of it — a picker that let the
 * file through and a server that refused it, with a helper line on screen promising the opposite of
 * the error underneath. Every one of them now derives from `UPLOADABLE_DOCUMENT_EXTENSIONS`, so the
 * disagreement has nowhere left to live.
 *
 * Two deliberate exclusions, for different reasons:
 *
 * - **Formats no reader here opens** — `.doc`, `.xls`, `.ppt` (OLE compound files from 1997) and
 *   `.bmp` (which libvips reads only through a magick delegate this sharp build lacks). The parser
 *   refuses each by name with a remedy; these lists keep them out of the picker in the first place.
 *   `REFUSED_UPLOAD_EXTENSIONS` names them so a test can assert no picker offers one.
 * - **Images** — the ten extensions `file-parser/utils/detect.ts` still routes at a reader that
 *   parses them. Withheld by choice, not by incapacity: project and team context is *document*
 *   context, an image contributes no text to a brief, and the chat composer — which applies no
 *   `accept` filter at all — is where a person attaches one. The reverse-direction assertion in
 *   `file-parser/tests/utils.test.ts` holds this list to every non-image format the parser routes,
 *   so the exclusion has to stay a decision rather than becoming an oversight.
 *
 * This module is a contracts leaf: no imports, no Node built-ins, so the renderer, the domain
 * stores, and the HTTP routes can all reach the same bytes.
 */

/**
 * Every document extension an upload picker offers, lowercase and dotted.
 *
 * The one constant. `file-parser/utils/detect.ts` decides whether a format parses; this list
 * decides whether a picker offers it, and the tests named above fail if the two disagree.
 */
export const UPLOADABLE_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
] as const;

/** Formats the parser refuses outright, so a test can assert no picker offers one. */
export const REFUSED_UPLOAD_EXTENSIONS = [".doc", ".xls", ".ppt", ".bmp"] as const;

/** The offered set as an `<input type="file" accept>` value. */
export const UPLOADABLE_DOCUMENT_ACCEPT = UPLOADABLE_DOCUMENT_EXTENSIONS.join(",");

/**
 * The offered set as prose: `PDF, DOCX, … or HTM`.
 *
 * Derived rather than written out, because a hand-written summary is exactly what let a helper line
 * promise a format the server went on to refuse.
 */
export const UPLOADABLE_DOCUMENT_LIST = joinWithOr(
  UPLOADABLE_DOCUMENT_EXTENSIONS.map((extension) => extension.slice(1).toUpperCase()),
);

/**
 * The helper line under a picker. Same set, same order, same source.
 *
 * No leading verb: the drop zone appends "Or browse files" after it.
 */
export const UPLOADABLE_DOCUMENT_HELPER = `${UPLOADABLE_DOCUMENT_LIST}.`;

/**
 * The 400 body a route writes when an upload's extension is not offered.
 *
 * `subject` names what the surface calls the thing, e.g. `project file` or `context document`.
 */
export function unsupportedUploadMessage(subject: string): string {
  return `Unsupported ${subject} type. Upload ${UPLOADABLE_DOCUMENT_LIST}.`;
}

/**
 * Whether an already-sanitized filename ends in an offered extension.
 *
 * The stores share this rather than each keeping its own `.some(endsWith)`: two copies of a
 * predicate are two chances to answer the same question differently. Case-insensitive, because a
 * picker on macOS hands back `REPORT.PDF` as readily as `report.pdf`.
 */
export function isUploadableDocumentFilename(filename: string): boolean {
  const normalized = filename.toLowerCase();
  return UPLOADABLE_DOCUMENT_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension),
  );
}

function joinWithOr(items: readonly string[]): string {
  const last = items[items.length - 1];
  if (last === undefined) return "nothing";
  if (items.length === 1) return last;
  return `${items.slice(0, -1).join(", ")}, or ${last}`;
}
