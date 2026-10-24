import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TeamFileStore } from "../../domains/team-files/team-file-store.js";
import { readTeamFileContext } from "../../domains/team-files/team-file-context.js";
import type { DocumentAnalysisRecord } from "../../domains/document-reader/types.js";
import {
  OCR_CONTRACT_VERSION,
  OCR_ENGINE,
  ocrContractIdentity,
} from "../../file-parser/ocr/contract.js";

const FILENAME = "operating-plan.pdf";
const PAGE_TEN_VALUE = "5170";

/**
 * A parsed owner whose manifest says exactly what the scenario under test says.
 *
 * The manifest is what the routing gate reads, so stating it directly is what makes each case a
 * statement about routing rather than about the parser.
 */
function makeParsedOwner(
  ocr: unknown,
  text = `Approved 2028 ${PAGE_TEN_VALUE}`,
  documentAnalysis?: DocumentAnalysisRecord,
): {
  store: TeamFileStore;
  ownerId: string;
  cleanup: () => void;
} {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "team-ocr-routing-"));
  const store = new TeamFileStore(workspacePath);
  const ownerId = "routing-draft";
  const inputsDir = store.inputsDir(ownerId);
  const parsedDir = path.join(inputsDir, "parsed");
  fs.mkdirSync(parsedDir, { recursive: true });
  fs.writeFileSync(path.join(inputsDir, FILENAME), "%PDF-1.7\nfixture");
  fs.writeFileSync(path.join(parsedDir, `${FILENAME}.md`), text);
  fs.writeFileSync(
    path.join(parsedDir, "_manifest.json"),
    JSON.stringify({
      generated_at: "2026-08-24T00:00:00.000Z",
      files: [
        {
          source: FILENAME,
          type: "pdf",
          sizeBytes: 17,
          outputs: { text: `${FILENAME}.md` },
          metadata: { has_encoding_issues: false },
          classification: "scanned",
          parseQuality: "medium",
          requiresLlm: true,
          needsOcr: true,
          status: "success",
          ...(ocr === undefined ? {} : { ocr }),
          ...(documentAnalysis === undefined ? {} : { documentAnalysis }),
        },
      ],
    }),
  );
  return {
    store,
    ownerId,
    cleanup: () => fs.rmSync(workspacePath, { recursive: true, force: true }),
  };
}

const completeOcr = {
  contractVersion: OCR_CONTRACT_VERSION,
  contractIdentity: ocrContractIdentity(),
  engine: OCR_ENGINE,
  status: "complete",
  applied: true,
  requestedPages: [10],
  readPages: [10],
  emptyPages: [],
  unresolvedPages: [],
  elapsedMs: 42,
};

test("a scanned PDF local OCR read completely does not require a document reader", async () => {
  const owner = makeParsedOwner(completeOcr);
  try {
    const files = await owner.store.listFiles(owner.ownerId);
    assert.equal(files[0]?.documentAnalysis?.status, "not_needed");

    const context = await readTeamFileContext(owner.store, owner.ownerId);
    assert.equal(context.documents.length, 1);
    assert.ok(context.documents[0]?.content.includes(PAGE_TEN_VALUE));
    assert.deepEqual(context.warnings, []);
  } finally {
    owner.cleanup();
  }
});

test("a partially read document keeps its readable pages and may still ask for a reader", async () => {
  const owner = makeParsedOwner({
    ...completeOcr,
    status: "partial",
    readPages: [10],
    unresolvedPages: [12],
  });
  try {
    const files = await owner.store.listFiles(owner.ownerId);
    assert.equal(
      files[0]?.documentAnalysis?.status,
      "required",
      "An unresolved page is a reason to offer a reader",
    );

    const context = await readTeamFileContext(owner.store, owner.ownerId);
    assert.equal(
      context.documents.length,
      1,
      "Readable pages stay usable while another page is unresolved",
    );
    assert.ok(context.documents[0]?.content.includes(PAGE_TEN_VALUE));
    assert.ok(
      context.warnings.some((warning) => warning.includes("could not be read")),
      "The user is told which part of the document is missing",
    );
  } finally {
    owner.cleanup();
  }
});

test("a document local OCR never ran on still requires a document reader", async () => {
  const owner = makeParsedOwner(undefined);
  try {
    const files = await owner.store.listFiles(owner.ownerId);
    assert.equal(files[0]?.documentAnalysis?.status, "required");

    const context = await readTeamFileContext(owner.store, owner.ownerId);
    assert.equal(context.documents.length, 0);
    assert.ok(context.warnings.some((warning) => warning.includes("document reader")));
  } finally {
    owner.cleanup();
  }
});

test("a cancelled OCR result is not treated as a complete reading", async () => {
  const owner = makeParsedOwner({ ...completeOcr, status: "cancelled", unresolvedPages: [12] });
  try {
    const files = await owner.store.listFiles(owner.ownerId);
    assert.equal(files[0]?.documentAnalysis?.status, "required");
  } finally {
    owner.cleanup();
  }
});

test("an OCR result from another contract cannot clear the document reader gate", async () => {
  const owner = makeParsedOwner({
    ...completeOcr,
    contractVersion: OCR_CONTRACT_VERSION - 1,
    contractIdentity: "v1:tesseract.js:eng:LSTM_ONLY:default:200dpi:spaces=1",
  });
  try {
    const files = await owner.store.listFiles(owner.ownerId);
    assert.equal(
      files[0]?.documentAnalysis?.status,
      "required",
      "A stale reading cannot prove that the current OCR contract read the document completely",
    );

    const context = await readTeamFileContext(owner.store, owner.ownerId);
    assert.equal(context.documents.length, 0);
  } finally {
    owner.cleanup();
  }
});

test("an OCR record that is not the shape this package writes is not trusted", async () => {
  for (const malformed of ["complete", { status: 7 }, { status: "complete", unresolvedPages: "none" }, []]) {
    const owner = makeParsedOwner(malformed);
    try {
      const files = await owner.store.listFiles(owner.ownerId);
      assert.equal(
        files[0]?.documentAnalysis?.status,
        "required",
        `A malformed OCR record must not clear the reader gate: ${JSON.stringify(malformed)}`,
      );
    } finally {
      owner.cleanup();
    }
  }
});

test("a partially read document keeps its locally read pages when the remote reader fails", async () => {
  const owner = makeParsedOwner(
    { ...completeOcr, status: "partial", readPages: [10], unresolvedPages: [12] },
    `Approved 2028 ${PAGE_TEN_VALUE}`,
    {
      status: "failed",
      provider: "openai",
      model: "gpt-test",
      generatedAt: "2026-08-24T01:00:00.000Z",
      promptVersion: 1,
      sourceHash: "fixture-hash",
      error: "OpenAI document reader failed (500)",
    },
  );
  try {
    const context = await readTeamFileContext(owner.store, owner.ownerId);
    assert.equal(
      context.documents.length,
      1,
      "Remote-reader failure must not delete the local OCR output",
    );
    assert.ok(context.documents[0]?.content.includes(PAGE_TEN_VALUE));
    assert.ok(
      context.warnings.some((warning) => warning.includes("12")),
      "The user is told which pages remain unresolved",
    );
    assert.ok(
      context.warnings.some(
        (warning) =>
          warning.includes("document reader") && !warning.includes("was not used"),
      ),
      "The user is told the remote read failed while the document stays in context",
    );
  } finally {
    owner.cleanup();
  }
});

test("an OCR record with an out-of-contract status or page number is not trusted", async () => {
  const cases: Array<{ label: string; ocr: unknown }> = [
    { label: "status outside the union", ocr: { ...completeOcr, status: "done" } },
    { label: "page zero was read", ocr: { ...completeOcr, readPages: [0] } },
    { label: "a negative page was read", ocr: { ...completeOcr, readPages: [-3] } },
    { label: "a fractional page was read", ocr: { ...completeOcr, readPages: [10.5] } },
    {
      label: "page zero is unresolved",
      ocr: { ...completeOcr, status: "partial", readPages: [10], unresolvedPages: [0] },
    },
    {
      label: "a fractional page is unresolved",
      ocr: { ...completeOcr, status: "partial", readPages: [10], unresolvedPages: [10.5] },
    },
  ];
  for (const { label, ocr } of cases) {
    const owner = makeParsedOwner(ocr);
    try {
      const files = await owner.store.listFiles(owner.ownerId);
      assert.equal(
        files[0]?.documentAnalysis?.status,
        "required",
        `An untrusted OCR record must not clear the reader gate: ${label}`,
      );

      const context = await readTeamFileContext(owner.store, owner.ownerId);
      assert.equal(
        context.documents.length,
        0,
        `An untrusted OCR record must not put pages into Team context: ${label}`,
      );
    } finally {
      owner.cleanup();
    }
  }
});
