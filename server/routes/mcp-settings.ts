import type * as http from "node:http";
import type { URL } from "node:url";

import * as z from "zod/v4";
import { whenDefined } from "../../core/optional-properties.js";

import type { McpServerInput } from "../../domains/mcp/mcp-settings.js";
import {
  McpSettingsServiceError,
  type McpSettingsService,
} from "../../services/mcp-settings-service.js";
import { decodeSafePathSegment } from "../../core/path-safety.js";
import {
  ApiRequestError,
  readJsonBody,
  writeJson,
} from "../http.js";

const MAX_SERVER_NAME_LENGTH = 160;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_ARGUMENT_LENGTH = 16_384;
const MAX_ARGUMENT_COUNT = 256;
const MAX_SECRET_LENGTH = 65_536;
const MAX_SECRET_COUNT = 256;
const MAX_URL_LENGTH = 4_096;
const MAX_SCOPE_LENGTH = 256;

const secretOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("preserve") }).strict(),
  z.object({ operation: z.literal("remove") }).strict(),
  z.object({
    operation: z.literal("replace"),
    value: z.string().min(1).max(MAX_SECRET_LENGTH),
  }).strict(),
]);

const secretMapSchema = z
  .record(z.string().min(1).max(256), secretOperationSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > MAX_SECRET_COUNT) {
      context.addIssue({
        code: "custom",
        message: `No more than ${MAX_SECRET_COUNT} secret fields are allowed`,
      });
    }
  });

const capabilityAliasSchema = z.object({
  capability: z.string().min(1).max(160),
  access: z.enum(["read", "write", "any"]).optional(),
}).strict();

const stdioTransportSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1).max(MAX_COMMAND_LENGTH),
  args: z.array(z.string().max(MAX_ARGUMENT_LENGTH)).max(MAX_ARGUMENT_COUNT).optional(),
  cwd: z.string().min(1).max(MAX_COMMAND_LENGTH).optional(),
  secretEnvironment: secretMapSchema.optional(),
}).strict();

const oauthAuthenticationSchema = z.object({
  type: z.literal("oauth"),
  authorizationServerUrl: z.string().min(1).max(MAX_URL_LENGTH).optional(),
  clientId: z.string().min(1).max(512).optional(),
  scopes: z.array(z.string().min(1).max(MAX_SCOPE_LENGTH)).max(256).optional(),
  secretCredentials: secretMapSchema.optional(),
}).strict();

const streamableHttpTransportSchema = z.object({
  type: z.literal("streamable-http"),
  url: z.string().min(1).max(MAX_URL_LENGTH),
  secretHeaders: secretMapSchema.optional(),
  authentication: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("secret-headers") }).strict(),
    oauthAuthenticationSchema,
  ]).optional(),
}).strict();

const createServerSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  name: z.string().min(1).max(MAX_SERVER_NAME_LENGTH),
  enabled: z.boolean().optional(),
  capabilityAliases: z.array(capabilityAliasSchema).max(256).optional(),
  transport: z.discriminatedUnion("type", [
    stdioTransportSchema,
    streamableHttpTransportSchema,
  ]),
}).strict();

const updateServerSchema = createServerSchema.omit({ id: true });
const setEnabledSchema = z.object({ enabled: z.boolean() }).strict();
const validateServerSchema = z.object({
  stdioTrustAcknowledged: z.boolean().optional(),
}).strict().transform((body) => ({
  ...whenDefined(body.stdioTrustAcknowledged, (stdioTrustAcknowledged) => ({
    stdioTrustAcknowledged,
  })),
}));

export async function handleMcpSettingsRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  service: McpSettingsService;
}): Promise<boolean> {
  const { req, res, url, service } = params;
  if (
    url.pathname !== "/settings/mcps" &&
    !url.pathname.startsWith("/settings/mcps/")
  ) {
    return false;
  }
  res.setHeader("cache-control", "no-store");

  try {
    if (url.pathname === "/settings/mcps") {
      if (req.method === "GET") {
        writeJson(res, 200, { servers: await service.listServers() });
        return true;
      }

      if (req.method === "POST") {
        const input = await parseRequestBody(req, createServerSchema);
        if (input.id && await service.getServer(input.id.trim())) {
          throw new ApiRequestError("MCP server id already exists", 409);
        }
        writeJson(res, 201, await service.saveServer(input as McpServerInput));
        return true;
      }

      return methodNotAllowed(res, ["GET", "POST"]);
    }

    const validateMatch = url.pathname.match(
      /^\/settings\/mcps\/([^/]+)\/validate$/,
    );
    if (validateMatch) {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      const serverId = parseServerId(validateMatch[1]);
      const input = await parseRequestBody(req, validateServerSchema);
      writeJson(res, 200, await service.validateServer(serverId, input));
      return true;
    }

    const reconnectMatch = url.pathname.match(
      /^\/settings\/mcps\/([^/]+)\/reconnect$/,
    );
    if (reconnectMatch) {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      const serverId = parseServerId(reconnectMatch[1]);
      writeJson(res, 200, await service.validateServer(serverId));
      return true;
    }

    const serverMatch = url.pathname.match(/^\/settings\/mcps\/([^/]+)$/);
    if (!serverMatch) return false;
    const serverId = parseServerId(serverMatch[1]);

    if (req.method === "PUT") {
      const input = await parseRequestBody(req, updateServerSchema);
      writeJson(
        res,
        200,
        await service.updateServer(serverId, input as McpServerInput),
      );
      return true;
    }

    if (req.method === "PATCH") {
      const input = await parseRequestBody(req, setEnabledSchema);
      writeJson(
        res,
        200,
        await service.setServerEnabled(serverId, input.enabled),
      );
      return true;
    }

    if (req.method === "DELETE") {
      const deleted = await service.deleteServer(serverId);
      if (!deleted) throw new ApiRequestError("MCP server was not found", 404);
      res.statusCode = 204;
      res.end();
      return true;
    }

    return methodNotAllowed(res, ["PUT", "PATCH", "DELETE"]);
  } catch (error) {
    if (error instanceof McpSettingsServiceError) {
      writeJson(res, statusCodeForMcpServiceError(error), {
        error: error.message,
        ...(error.server ? { server: error.server } : {}),
      });
      return true;
    }
    throw error;
  }
}

async function parseRequestBody<TSchema extends z.ZodType>(
  req: http.IncomingMessage,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  const result = schema.safeParse(await readJsonBody(req));
  if (!result.success) {
    throw new ApiRequestError("Invalid MCP settings request body", 400);
  }
  return result.data;
}

function parseServerId(encodedId: string | undefined): string {
  const serverId = encodedId ? decodeSafePathSegment(encodedId) : null;
  if (!serverId) throw new ApiRequestError("Invalid MCP server id", 400);
  return serverId;
}

function methodNotAllowed(
  res: http.ServerResponse,
  allowedMethods: readonly string[],
): true {
  res.setHeader("allow", allowedMethods.join(", "));
  writeJson(res, 405, { error: "Method not allowed" });
  return true;
}

function statusCodeForMcpServiceError(
  error: McpSettingsServiceError,
): 400 | 404 | 409 | 502 {
  switch (error.code) {
    case "invalid_request":
    case "configuration_invalid":
      return 400;
    case "not_found":
      return 404;
    case "server_disabled":
    case "server_revoked":
    case "unauthorized":
      return 409;
    default:
      return 502;
  }
}
