import { expect, test } from "vitest";

import {
  TEAM_CONTEXT_FILE_ACCEPT,
  TEAM_CONTEXT_FILE_HELPER,
} from "@/lib/clients/team-file-client";
import {
  REFUSED_UPLOAD_EXTENSIONS,
  UPLOADABLE_DOCUMENT_ACCEPT,
  UPLOADABLE_DOCUMENT_EXTENSIONS,
  UPLOADABLE_DOCUMENT_HELPER,
} from "@/lib/utils/uploadable-formats";

/**
 * What the renderer alone can be wrong about.
 *
 * Whether a format parses is asserted in `file-parser/tests/utils.test.ts`; whether the servers
 * accept it is asserted in `tests/unit/upload-format-agreement.test.ts` and
 * `tests/integration/upload-format-routes.test.ts`. All three read the same
 * `contracts/uploadable-formats.ts`. What is left here is the renderer's own half: that both
 * pickers offer the shared list unchanged, and that the sentence printed under the button does not
 * promise a format the button will not send.
 */

const accepted = UPLOADABLE_DOCUMENT_ACCEPT.split(",");

test("the picker offers the shared list and nothing else", () => {
  expect(accepted).toEqual([...UPLOADABLE_DOCUMENT_EXTENSIONS]);
  expect(new Set(accepted).size).toBe(accepted.length);
  for (const extension of accepted) {
    expect(extension).toMatch(/^\.[a-z0-9]+$/);
  }
});

test("no picker offers a format the parser refuses outright", () => {
  for (const extension of REFUSED_UPLOAD_EXTENSIONS) {
    expect(accepted).not.toContain(extension);
    expect(TEAM_CONTEXT_FILE_ACCEPT.split(",")).not.toContain(extension);
  }
});

test("the project picker and the team picker offer the same formats", () => {
  expect(TEAM_CONTEXT_FILE_ACCEPT).toBe(UPLOADABLE_DOCUMENT_ACCEPT);
});

test("the helper line names every offered format and promises no other", () => {
  // The line used to summarise by family — "PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV,
  // or text" — which is how it came to promise formats the server then refused with a 400. It is
  // now composed from the same list the `accept` attribute is.
  const named = UPLOADABLE_DOCUMENT_HELPER.replace(/\.$/, "")
    .split(/,\s*(?:or\s*)?/)
    .map((name) => `.${name.toLowerCase()}`);

  expect(named).toEqual([...UPLOADABLE_DOCUMENT_EXTENSIONS]);
  expect(TEAM_CONTEXT_FILE_HELPER).toContain(UPLOADABLE_DOCUMENT_HELPER);
  expect(TEAM_CONTEXT_FILE_HELPER).toContain("Up to 8 documents.");
});

test("images are withheld from document context, and the module says so", () => {
  // The docstring used to claim the lists tracked `detect.ts` exactly, while omitting ten image
  // formats it parses. The omission is a choice — see `contracts/uploadable-formats.ts` — and the
  // reverse-direction assertion that holds the choice honest lives in the parser's own suite.
  for (const extension of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]) {
    expect(accepted).not.toContain(extension);
  }
});
