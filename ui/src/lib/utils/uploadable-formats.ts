/**
 * What an upload picker offers, re-exported from the one place every layer reads.
 *
 * The list itself, the prose under the button, and the sentence each route writes into its 400 all
 * live in `contracts/uploadable-formats.ts` — the only module the renderer, the domain stores, and
 * the HTTP routes can all import. Nothing is restated here: a second copy is what let the picker
 * offer nine formats the servers went on to refuse.
 *
 * Images are absent on purpose, and `file-parser/utils/detect.ts` parses all ten it still routes.
 * Project and team context are document context; the chat composer, which filters nothing, is where
 * an image is attached. See the contracts module for the whole argument.
 */

export {
  REFUSED_UPLOAD_EXTENSIONS,
  UPLOADABLE_DOCUMENT_ACCEPT,
  UPLOADABLE_DOCUMENT_EXTENSIONS,
  UPLOADABLE_DOCUMENT_HELPER,
  UPLOADABLE_DOCUMENT_LIST,
} from "@contracts/uploadable-formats";
