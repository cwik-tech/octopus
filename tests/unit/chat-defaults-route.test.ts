import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { handleCreateSupportRoutes } from "../../server/routes/create-support.js";
import type { ProviderSettingsSnapshot } from "../../domains/provider/provider-settings.js";

/**
 * The route, not the service beneath it.
 *
 * `getChatDefaults(repoRoot)` alone cannot show this: what matters is what the
 * route hands it from the provider snapshot. The snapshot names a default only
 * when one was stored and can run, so with nothing stored the Run composer has
 * to start on the persona's own pair rather than on anything the catalog would
 * offer first.
 */

interface ChatDefaultsBody {
  readonly run: { readonly provider: string; readonly model: string };
  readonly workflow: { readonly provider: string; readonly model: string };
}

function snapshotWith(
  defaultModel: { provider: string; model: string } | null,
): ProviderSettingsSnapshot {
  return {
    connections: [],
    cliAgents: [],
    catalog: [],
    defaultModel,
    // The pair is present exactly when a stored default can run, so the state
    // follows from it.
    defaultModelState: defaultModel
      ? { status: "available", ...defaultModel }
      : { status: "unset" },
    effortCapabilities: [],
    defaultEffort: "medium" as const,
  };
}

async function readChatDefaults(input: {
  repoRootPath: string;
  snapshot: ProviderSettingsSnapshot;
}): Promise<ChatDefaultsBody> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleCreateSupportRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: input.repoRootPath,
        createJobRegistry: {
          cancelAndWait: async (jobId: string) => ({
            jobId,
            cancelled: true as const,
            status: "cancelled" as const,
          }),
        },
        providerSettingsService: {
          snapshot: async () => input.snapshot,
        },
      },
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/create/chat-defaults`,
    );
    assert.equal(response.status, 200);
    return (await response.json()) as ChatDefaultsBody;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function writeFrontDoor(repoRoot: string): void {
  const directory = path.join(repoRoot, "agents", "general-agent");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "general-agent.md"),
    [
      "---",
      "name: general-agent",
      "description: The Run front door.",
      "tier: orchestration",
      "provider: persona-provider",
      "model: persona-model",
      "thinking: low",
      "system: true",
      "---",
      "",
      "# General Agent",
      "",
    ].join("\n"),
  );
}

test("the chat-defaults route starts the Run composer on the persona when no default is stored", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-defaults-route-"));
  try {
    writeFrontDoor(repoRoot);

    const body = await readChatDefaults({
      repoRootPath: repoRoot,
      snapshot: snapshotWith(null),
    });

    assert.deepEqual(body.run, {
      provider: "persona-provider",
      model: "persona-model",
    });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the chat-defaults route honours a default the user stored", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-defaults-route-"));
  try {
    writeFrontDoor(repoRoot);

    const body = await readChatDefaults({
      repoRootPath: repoRoot,
      snapshot: snapshotWith({
        provider: "connection:chosen",
        model: "chosen-model",
      }),
    });

    assert.deepEqual(body.run, {
      provider: "connection:chosen",
      model: "chosen-model",
    });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
