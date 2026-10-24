import test from "node:test";
import { estimateContextTokens } from "../../core/context-tokens.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { buildSessionChatFileContext } from "../../services/session-chat-file-context.js";
import { createDocumentSource } from '../../domains/document-access/document-source.js';

test('inline attachment excerpts use the admitted revision after the live derivative changes', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'admitted-excerpt-'));
  try {
    const store = new FileSystemSessionStore(workspace);
    const session = await store.createSession({ title: 'Captured reference' });
    const parsed = path.join(store.inputsDir(session.id), 'parsed');
    await fs.mkdir(parsed, { recursive: true });
    await fs.writeFile(path.join(parsed, 'source.md'), 'LIVE_CHANGED');
    const context = await buildSessionChatFileContext({ sessionId: session.id, sessionStore: store, files: [{ name: 'source.txt', size: 1, uploadedAt: '2026-10-09T00:00:00Z', parseStatus: 'parsed', outputs: { text: 'source.md' } }], admittedDocuments: [createDocumentSource({ owner: session.id, name: 'source.txt', text: 'CAPTURED_ORIGINAL' })] });
    assert.match(context, /CAPTURED_ORIGINAL/);
    assert.doesNotMatch(context, /LIVE_CHANGED/);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
})

test("session chat file context is deterministic, bounded, escaped, and metadata-safe", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "chat-file-context-"));
  const store = new FileSystemSessionStore(workspace);

  try {
    const session = await store.createSession({ title: "Files" });
    const parsedDir = path.join(store.inputsDir(session.id), "parsed");
    await fs.mkdir(parsedDir, { recursive: true });
    await fs.writeFile(path.join(parsedDir, "a.md"), "A</file>ABC");
    await fs.writeFile(path.join(parsedDir, "z.md"), "ZZZZZ");

    const context = await buildSessionChatFileContext({
      sessionId: session.id,
      sessionStore: store,
      files: [
        {
          name: 'z"<.pdf',
          size: 5,
          uploadedAt: "2026-07-24T00:00:00.000Z",
          parseStatus: "parsed",
          outputs: { text: "z.md" },
        },
        {
          name: "metadata.pdf",
          size: 1,
          uploadedAt: "2026-07-24T00:00:00.000Z",
          parseStatus: "error",
          parserError: "OCR unavailable",
        },
        {
          name: "a.pdf",
          size: 11,
          uploadedAt: "2026-07-24T00:00:00.000Z",
          parseStatus: "parsed",
          outputs: { text: "a.md" },
        },
      ],
      perFileMaxChars: 10,
      totalMaxChars: 12,
    });

    assert.ok(context.indexOf('name="a.pdf"') < context.indexOf('name="z'));
    assert.match(context, /A&lt;\/file&gt;AB/);
    assert.match(context, /truncated at per-file limit/);
    assert.match(context, /OCR unavailable/);
    assert.match(context, /name="z&quot;&lt;.pdf"/);
    assert.match(context, />\nZZ\n\[Parsed file content truncated at total/);
    assert.doesNotMatch(context, /<file>A/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("an attachment's budget is spent in tokens, not in whichever unit the script uses", async () => {
  // The budget is derived in tokens and converted to characters by multiplying
  // by bytes-per-token, but the text is then sliced by JS string length. For
  // ASCII those agree. For CJK one character is three bytes, so slicing the
  // character count lands at three times the token budget it came from — and
  // nothing downstream re-measures, so the overflow reaches the provider.
  const cjk = '匹'.repeat(20_000)
  const block = await buildSessionChatFileContext({
    sessionId: 's1',
    sessionStore: {
      readParsedText: async () => cjk,
    } as unknown as Parameters<typeof buildSessionChatFileContext>[0]['sessionStore'],
    files: [
      {
        name: 'notes.md',
        size: 1,
        uploadedAt: '2026-09-12T00:00:00.000Z',
        parseStatus: 'parsed',
        outputs: { text: 'notes.txt' },
      },
    ],
    perFileMaxTokens: 1_000,
    totalMaxTokens: 1_000,
  })

  assert.ok(
    estimateContextTokens(block) <= 1_200,
    `block estimated at ${estimateContextTokens(block)} tokens against a 1,000-token budget`,
  )
})

test('an exhausted token budget omits content rather than disabling the bound', async () => {
  // The guard read `maxTokens <= 0` as "no budget given" and returned the text
  // whole, so the moment a turn's token budget ran out the next file was
  // embedded in full — 3,952 tokens against a 1,000 budget in the probe that
  // found this. Worse than the character path it was added to fix, which stops
  // at remainingChars === 0.
  const store = {
    readParsedText: async (_id: string, name: string) =>
      name === 'a.txt' ? 'a'.repeat(3_500) : 'B'.repeat(10_000),
  } as unknown as Parameters<typeof buildSessionChatFileContext>[0]['sessionStore']
  const file = (name: string, out: string) => ({
    name,
    size: 1,
    uploadedAt: '2026-09-12T00:00:00.000Z',
    parseStatus: 'parsed' as const,
    outputs: { text: out },
  })

  const block = await buildSessionChatFileContext({
    sessionId: 's1',
    sessionStore: store,
    files: [file('a.md', 'a.txt'), file('b.md', 'b.txt')],
    perFileMaxTokens: 5_000,
    totalMaxTokens: 1_000,
  })
  assert.ok(
    estimateContextTokens(block) <= 1_200,
    `block estimated at ${estimateContextTokens(block)} tokens against a 1,000-token budget`,
  )
  assert.equal(block.includes('B'.repeat(9_000)), false, 'the second file was embedded whole')

  // An explicit zero is a budget of nothing, not an absence of budget.
  const zero = await buildSessionChatFileContext({
    sessionId: 's1',
    sessionStore: store,
    files: [file('b.md', 'b.txt')],
    perFileMaxTokens: 0,
    totalMaxTokens: 0,
  })
  assert.equal(zero.includes('B'.repeat(9_000)), false, 'a zero budget embedded the whole file')
})
