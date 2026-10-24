import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";

import {
  ApiRequestError,
  readJsonBody,
} from "../../core/http-json-body.js";

test("JSON body reader preserves content-type and empty-body behavior over real HTTP", async () => {
  assert.deepEqual(await requestBody({ body: "" }), {
    statusCode: 200,
    payload: {},
  });
  assert.deepEqual(await requestBody({ body: "{}" }), {
    statusCode: 415,
    payload: { error: "Content-Type must be application/json" },
  });
  assert.deepEqual(
    await requestBody({
      body: '{"ok":true}',
      contentType: " application/vnd.pipeline+json; charset=utf-8",
    }),
    {
      statusCode: 200,
      payload: { ok: true },
    },
  );
  assert.deepEqual(
    await requestBody({
      body: "{}",
      contentType: "text/plain",
    }),
    {
      statusCode: 415,
      payload: { error: "Content-Type must be application/json" },
    },
  );
  assert.deepEqual(
    await requestBody({
      body: "{",
      contentType: "application/json",
    }),
    {
      statusCode: 400,
      payload: { error: "Invalid JSON request body" },
    },
  );
});

test("JSON body reader preserves custom and default byte limits over real HTTP", async () => {
  assert.deepEqual(
    await requestBody({
      body: "{}",
      contentType: "application/json",
      maxBodyBytes: 2,
    }),
    {
      statusCode: 200,
      payload: {},
    },
  );
  assert.deepEqual(
    await requestBody({
      body: " {}",
      contentType: "application/json",
      maxBodyBytes: 2,
    }),
    {
      statusCode: 413,
      payload: { error: "Request body exceeds 2-byte limit" },
    },
  );
  assert.deepEqual(
    await requestBody({
      body: JSON.stringify({ padding: "x".repeat(1_048_576) }),
      contentType: "application/json",
    }),
    {
      statusCode: 413,
      payload: { error: "Request body exceeds 1 MiB limit" },
    },
  );
});

async function requestBody(params: {
  readonly body: string;
  readonly contentType?: string;
  readonly maxBodyBytes?: number;
}): Promise<{ statusCode: number; payload: unknown }> {
  const server = http.createServer(async (req, res) => {
    try {
      const payload = await readJsonBody(req, params.maxBodyBytes);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    } catch (error) {
      const statusCode =
        error instanceof ApiRequestError ? error.statusCode : 500;
      res.statusCode = statusCode;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP body fixture did not start");
  }

  try {
    return await new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = {
        "content-length": Buffer.byteLength(params.body),
      };
      if (params.contentType !== undefined) {
        headers["content-type"] = params.contentType;
      }
      const request = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/",
          method: "POST",
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              statusCode: response.statusCode ?? 0,
              payload: JSON.parse(body) as unknown,
            });
          });
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end(params.body);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
