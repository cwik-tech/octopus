import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import {
  documentReaderSelectionError,
  readPdfWithDocumentReader,
} from "../../domains/document-reader/document-reader.js";
import { setConfiguredProviderConnections } from "../../providers/configured-provider.js";

for (const pages of [[], [{ page: 1, content: 'Only the first page.', keyFacts: [] }], [{ page: 1, content: 'Duplicate.', keyFacts: [] }, { page: 1, content: 'Duplicate again.', keyFacts: [] }]]) test('a PDF reader refuses incomplete or duplicate page evidence for a known two-page PDF', async () => {
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ output_text: JSON.stringify({ summary: 'Summary alone is insufficient.', pages, warnings: [] }) })) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const previousKey = process.env.GEMINI_API_KEY
  const previousUrl = process.env.DOCUMENT_READER_GEMINI_BASE_URL
  process.env.GEMINI_API_KEY = 'fixture'
  process.env.DOCUMENT_READER_GEMINI_BASE_URL = `http://127.0.0.1:${address.port}`
  try {
    const result = await readPdfWithDocumentReader({ selection: { provider: 'gemini', model: 'fixture' }, filename: 'two-page.pdf', contents: Buffer.from('fixture'), expectedPageCount: 2, signal: AbortSignal.timeout(2_000) })
    assert.equal(result.ok, false, 'Partial evidence must never become ready full-PDF evidence')
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.DOCUMENT_READER_GEMINI_BASE_URL; else process.env.DOCUMENT_READER_GEMINI_BASE_URL = previousUrl
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("document reader rejects text-only DeepSeek for PDF input", () => {
  assert.match(
    documentReaderSelectionError({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    }) ?? "",
    /text-only/,
  );
});

test("document reader accepts only configured OpenAI API connections", () => {
  try {
    setConfiguredProviderConnections([
      {
        id: "openai-pdf",
        kind: "openai-compatible",
        name: "OpenAI PDF",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
      },
      {
        id: "local-chat",
        kind: "lm-studio",
        name: "Local Chat",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ]);

    assert.equal(
      documentReaderSelectionError({
        provider: "connection:openai-pdf",
        model: "gpt-test",
      }),
      null,
    );
    assert.match(
      documentReaderSelectionError({
        provider: "connection:local-chat",
        model: "local-test",
      }) ?? "",
      /OpenAI API connection/,
    );
  } finally {
    setConfiguredProviderConnections([]);
  }
});

test("Gemini document reader sends the original PDF as an interaction document", async () => {
  let receivedBody: Record<string, unknown> | undefined;
  let receivedApiKey: string | undefined;
  const provider = http.createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/interactions");
    const apiKey = request.headers["x-goog-api-key"];
    receivedApiKey = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Recovered from the PDF.",
            pages: [
              {
                page: 1,
                content: "Page one evidence.",
                keyFacts: ["A verified fact."],
              },
            ],
            warnings: [],
          }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const previousKey = process.env.GEMINI_API_KEY;
  const previousBaseUrl = process.env.DOCUMENT_READER_GEMINI_BASE_URL;
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.DOCUMENT_READER_GEMINI_BASE_URL = `http://127.0.0.1:${address.port}`;

  try {
    const result = await readPdfWithDocumentReader({
      selection: { provider: "gemini", model: "gemini-test" },
      filename: "scanned.pdf",
      contents: Buffer.from("%PDF-1.7 scanned fixture"),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.evidence.pages[0]?.content, "Page one evidence.");
    assert.equal(receivedApiKey, "gemini-test-key");
    assert.equal(receivedBody?.model, "gemini-test");
    const input = receivedBody?.input as Array<Record<string, unknown>>;
    assert.equal(input[1]?.type, "document");
    assert.equal(input[1]?.mime_type, "application/pdf");
    assert.equal(input[1]?.data, Buffer.from("%PDF-1.7 scanned fixture").toString("base64"));
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.DOCUMENT_READER_GEMINI_BASE_URL;
    else process.env.DOCUMENT_READER_GEMINI_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
