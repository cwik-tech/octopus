import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";

import { ApiRequestError } from "../../core/http-json-body.js";
import { writeJson } from "../../server/http.js";
import { handleCreateSupportRoutes } from "../../server/routes/create-support.js";

test("reveal-artifact preserves JSON media-type and syntax errors", async () => {
  await withCreateSupportServer(async (url) => {
    assert.deepEqual(
      await post(url, "{}", "text/plain"),
      {
        statusCode: 415,
        payload: { error: "Content-Type must be application/json" },
      },
    );
    assert.deepEqual(
      await post(url, "{", "application/json"),
      {
        statusCode: 400,
        payload: { error: "Invalid JSON request body" },
      },
    );
  });
});

test("reveal-artifact preserves null, no-coercion, and path errors", async () => {
  await withCreateSupportServer(async (url) => {
    const cases: Array<[unknown, string]> = [
      [null, "Request body must be a JSON object"],
      [[], "Request body must be a JSON object"],
      [{ artifactPath: 42 }, "Field artifactPath is required and must be a string"],
      [{ artifactPath: "   " }, "Field artifactPath must not be empty"],
      [{ artifactPath: "/tmp/report.md" }, "Field artifactPath must be a relative path"],
      [{ artifactPath: "output/\0report.md" }, "Field artifactPath must be a relative path"],
    ];
    for (const [body, message] of cases) {
      assert.deepEqual(
        await post(url, JSON.stringify(body), "application/json"),
        {
          statusCode: 400,
          payload: { error: message },
        },
      );
    }
  });
});

test("reveal-artifact strips unknown fields and trims before lookup", async () => {
  await withCreateSupportServer(async (url) => {
    assert.deepEqual(
      await post(
        url,
        JSON.stringify({
          artifactPath: "  output/missing.md  ",
          ignored: true,
        }),
        "application/json",
      ),
      {
        statusCode: 404,
        payload: {
          error:
            "Artifact file does not exist yet: output/missing.md",
        },
      },
    );
  });
});

async function withCreateSupportServer(
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handleCreateSupportRoutes({
        req,
        res,
        url: new URL(req.url ?? "/", "http://127.0.0.1"),
        options: {
          repoRootPath: process.cwd(),
          workspacePath: process.cwd(),
          createJobRegistry: {
            async cancelAndWait(jobId: string) {
              return {
                jobId,
                cancelled: true,
                status: "cancelled" as const,
              };
            },
          },
          providerSettingsService: {
            async snapshot() {
              return {
                defaultModel: null,
              } as never;
            },
          },
        },
      });
      if (!handled) writeJson(res, 404, { error: "Not found" });
    } catch (error) {
      writeJson(
        res,
        error instanceof ApiRequestError ? error.statusCode : 500,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Create support fixture did not start");
  }
  try {
    await run(`http://127.0.0.1:${address.port}/create/reveal-artifact`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function post(
  url: string,
  body: string,
  contentType: string,
): Promise<{ statusCode: number; payload: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  return {
    statusCode: response.status,
    payload: await response.json(),
  };
}
