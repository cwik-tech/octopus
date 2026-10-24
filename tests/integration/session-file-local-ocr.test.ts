/**
 * One PDF uploaded once in Run reaches both Run chat service paths as recognized text.
 *
 * Every ordinary Run branch renders the same chat controller, which posts to
 * `/sessions/:id/files`. This exercises that real route, the real filesystem session store, the
 * real file-parser child process and the real mixed fixture, then drives both consumers of the
 * parsed result: `runSessionMessageTurn` for receptionist and workflow chat, and
 * `runSessionAgentChatTurn` for direct Agent or Team chat.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as http from "node:http";

import { startApiServer } from "../../server/api-server.js";
import { registerProvider } from "../../providers/registry.js";
import type { Provider, ProviderExecuteOptions } from "../../providers/types.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { SourceFileParserLauncher } from "../../core/file-parser-launcher.js";
import { MIXED_OCR_FIXTURE } from "../../file-parser/tests/mixed-ocr-expectations.js";

const PROVIDER_NAME = "fake-local-ocr-run-chat";

function fixtureBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(fs.readFileSync(
    path.join(
      process.cwd(),
      "file-parser",
      "tests",
      "fixtures",
      MIXED_OCR_FIXTURE.fileName,
    ),
  ));
}

function writeChatAgent(repoRootPath: string, name: string): void {
  const dir = path.join(repoRootPath, "agents", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    [
      "---",
      `name: ${name}`,
      `description: ${name} reads uploaded documents`,
      `provider: ${PROVIDER_NAME}`,
      "model: fake-model",
      "---",
      "",
      `You are ${name}.`,
      "",
    ].join("\n"),
  );
}

test("one Run upload gives receptionist chat and direct Agent chat the same recognized text", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "run-local-ocr-workspace-"));
  const repoRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "run-local-ocr-repo-"));
  fs.mkdirSync(path.join(repoRootPath, "workflows"), { recursive: true });
  writeChatAgent(repoRootPath, "analyst");

  // Receptionist and workflow chat reach the model over HTTP, so the endpoint is a loopback
  // server here rather than a registered provider double. Every prompt either path sends is
  // recorded, and the recognized value is asserted in both.
  const prompts: string[] = [];
  const model = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      prompts.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reply: "Read the uploaded plan.",
                  launchIntent: "none",
                  requiredInputs: [],
                }),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelAddress = model.address();
  assert.ok(modelAddress && typeof modelAddress !== "string");
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "test-local-ocr-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL =
    `http://127.0.0.1:${modelAddress.port}/v1/chat/completions`;

  const agentPrompts: ProviderExecuteOptions[] = [];
  const provider: Provider = {
    name: PROVIDER_NAME,
    async execute(options) {
      agentPrompts.push(options);
      return {
        // A tool-free provider now reviews the source in bounded fragments before
        // its final answer. The model fixture must honor that structured contract.
        text: options.systemPrompt.startsWith("Review this fragment")
          ? JSON.stringify({ evidence: options.userMessage.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028) ? [MIXED_OCR_FIXTURE.page10.salesMarketing2028] : [] })
          : JSON.stringify({
            reply: "Read the uploaded plan.",
            plan: { status: "gathering", requiredInputs: [], actions: [] },
          }),
        cost: 0,
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        model: options.model,
      };
    },
  };
  registerProvider(provider, {
    source: "tests/integration/session-file-local-ocr.test.ts",
    trustClass: "test",
  });

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 0, cwd: "" };
      },
    },
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    repoRootPath,
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
  });

  try {
    const created = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Operating plan review" }),
    });
    assert.equal(created.status, 201);
    const sessionId = (await created.json() as { id: string }).id;

    // The one upload every ordinary Run branch performs.
    const uploaded = await fetch(`${server.url}/sessions/${sessionId}/files`, {
      method: "POST",
      headers: { "x-filename": encodeURIComponent(MIXED_OCR_FIXTURE.fileName) },
      body: fixtureBytes(),
    });
    assert.equal(uploaded.status, 201);
    const file = await uploaded.json() as {
      parseStatus: string;
      outputs?: Record<string, string>;
    };
    assert.equal(file.parseStatus, "parsed");

    const parsedText = fs.readFileSync(
      path.join(workspacePath, "sessions", sessionId, "inputs", "parsed", file.outputs!.text!),
      "utf8",
    );
    assert.ok(
      parsedText.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028),
      "The session route must invoke the shared parser and store the merged reading",
    );

    // Receptionist and workflow chat.
    const receptionist = await fetch(`${server.url}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "What is approved for Sales & Marketing in 2028?",
        provider: "openai",
        model: "gpt-test",
      }),
    });
    assert.equal(receptionist.status, 201);
    const receptionistPrompt = prompts.at(-1);
    assert.ok(receptionistPrompt, "The receptionist turn must reach the model");
    assert.ok(
      receptionistPrompt.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028),
      "Receptionist and workflow context must contain the page 10 recognized value",
    );

    // Direct Agent or Team chat, from the same upload.
    const agentChat = await fetch(
      `${server.url}/sessions/${sessionId}/agent-chat/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "What is approved for Sales & Marketing in 2028?",
          agentNames: ["analyst"],
          provider: PROVIDER_NAME,
          model: "fake-model",
        }),
      },
    );
    assert.equal(agentChat.status, 201);
    const agentPrompt = agentPrompts.at(-1);
    assert.ok(agentPrompt, "The direct Agent turn must reach the provider");
    assert.ok(
      `${agentPrompt.systemPrompt}${agentPrompt.userMessage}`.includes(
        MIXED_OCR_FIXTURE.page10.salesMarketing2028,
      ),
      "Direct Agent or Team context must contain the page 10 recognized value",
    );
  } finally {
    await server.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl;
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRootPath, { recursive: true, force: true });
  }
});
