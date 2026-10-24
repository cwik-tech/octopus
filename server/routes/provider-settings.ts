import { whenDefined } from "../../core/optional-properties.js"
import type * as http from "node:http";
import type { URL } from "node:url";

import {
  defaultEffortRequestSchema,
  defaultModelRequestSchema,
  enabledRequestSchema,
  modelEnabledRequestSchema,
  providerConnectionRequestSchema,
  providerExecuteRequestSchema,
} from "../../contracts/schemas/settings-requests.js";
import type { ProviderConnectionInput } from "../../domains/provider/provider-settings.js";
import type { ProviderSettingsService } from "../../services/provider-settings-service.js";
import {
  ProviderError,
  serializeProviderError,
} from "../../domains/provider/provider-error.js";
import {
  ApiRequestError,
  parseApiRequest,
  readJsonBody,
  writeJson,
} from "../http.js";

export async function handleProviderSettingsRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  service: ProviderSettingsService;
}): Promise<boolean> {
  const { req, res, url, service } = params;

  if (req.method === "GET" && url.pathname === "/settings/providers") {
    writeJson(res, 200, await (url.searchParams.get("refresh") === "1" ? service.snapshot(true) : service.cachedSnapshot()));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/settings/model-catalog") {
    const snapshot = await (url.searchParams.get("refresh") === "1" ? service.snapshot(true) : service.cachedSnapshot());
    writeJson(res, 200, {
      catalog: snapshot.catalog,
      defaultEffort: snapshot.defaultEffort,
      // The effort ranges travel beside the catalogue rather than inside it:
      // an Agent may name a built-in API provider that appears in no group.
      effortCapabilities: snapshot.effortCapabilities,
      defaultModel: snapshot.defaultModel,
      // The state, not only the usable pair, so the UI can name a default that
      // is configured but currently unavailable instead of showing none.
      defaultModelState: snapshot.defaultModelState,
    });
    return true;
  }

  if (req.method === "PATCH" && url.pathname === "/settings/default-effort") {
    const body = parseApiRequest(
      defaultEffortRequestSchema,
      await readJsonBody(req),
    );
    try {
      writeJson(res, 200, {
        defaultEffort: await service.setDefaultEffort(body.effort),
      });
    } catch (error) {
      throw new ApiRequestError(
        error instanceof Error ? error.message : String(error),
        409,
      );
    }
    return true;
  }

  if (req.method === "PATCH" && url.pathname === "/settings/default-model") {
    const body = parseApiRequest(
      defaultModelRequestSchema,
      await readJsonBody(req),
    );
    try {
      writeJson(res, 200, {
        defaultModel: await service.setDefaultModel({
          provider: body.provider,
          model: body.model,
        }),
      });
    } catch (error) {
      throw new ApiRequestError(
        error instanceof Error ? error.message : String(error),
        409,
      );
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/settings/provider-execute") {
    const body = parseApiRequest(
      providerExecuteRequestSchema,
      await readJsonBody(req),
    );
    try {
      writeJson(
        res,
        200,
        await service.executeConfiguredProvider(body.provider, {
          systemPrompt: body.systemPrompt,
          userMessage: body.userMessage,
          model: body.model,
          thinking: body.thinking,
          ...whenDefined(body.providerConfig, (definedValue) => ({ providerConfig: definedValue })),
        }),
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        writeJson(
          res,
          error.statusCode ?? 502,
          serializeProviderError(error),
        );
        return true;
      }
      throw error;
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/settings/providers") {
    const input = parseConnectionInput(await readJsonBody(req));
    writeJson(res, 201, await service.saveConnection(input));
    return true;
  }

  const connectionMatch = url.pathname.match(/^\/settings\/providers\/([^/]+)$/);
  if (connectionMatch) {
    const connectionId = decodeURIComponent(connectionMatch[1] ?? "");
    if (req.method === "DELETE") {
      await service.deleteConnection(connectionId);
      writeJson(res, 200, { deleted: true });
      return true;
    }
    if (req.method === "PATCH") {
      const body = parseApiRequest(
        enabledRequestSchema,
        await readJsonBody(req),
      );
      writeJson(
        res,
        200,
        await service.setConnectionEnabled(connectionId, body.enabled),
      );
      return true;
    }
  }

  const validateMatch = url.pathname.match(
    /^\/settings\/providers\/([^/]+)\/validate$/,
  );
  if (req.method === "POST" && validateMatch) {
    writeJson(
      res,
      200,
      await service.validateConnection(decodeURIComponent(validateMatch[1] ?? "")),
    );
    return true;
  }

  const modelMatch = url.pathname.match(
    /^\/settings\/providers\/([^/]+)\/models$/,
  );
  if (req.method === "PATCH" && modelMatch) {
    const body = parseApiRequest(
      modelEnabledRequestSchema,
      await readJsonBody(req),
    );
    writeJson(
      res,
      200,
      await service.setModelEnabled(
        decodeURIComponent(modelMatch[1] ?? ""),
        body.modelId,
        body.enabled,
      ),
    );
    return true;
  }

  if (req.method === "POST" && url.pathname === "/settings/cli/refresh") {
    writeJson(res, 200, { cliAgents: await service.listCliAgents(true) });
    return true;
  }

  const cliMatch = url.pathname.match(/^\/settings\/cli\/([^/]+)$/);
  if (req.method === "PATCH" && cliMatch) {
    const body = parseApiRequest(
      enabledRequestSchema,
      await readJsonBody(req),
    );
    writeJson(res, 200, {
      cliAgents: await service.setCliEnabled(
        decodeURIComponent(cliMatch[1] ?? ""),
        body.enabled,
      ),
    });
    return true;
  }

  const cliModelMatch = url.pathname.match(
    /^\/settings\/cli\/([^/]+)\/models$/,
  );
  if (req.method === "PATCH" && cliModelMatch) {
    const body = parseApiRequest(
      modelEnabledRequestSchema,
      await readJsonBody(req),
    );
    writeJson(res, 200, {
      cliAgents: await service.setCliModelEnabled(
        decodeURIComponent(cliModelMatch[1] ?? ""),
        body.modelId,
        body.enabled,
      ),
    });
    return true;
  }

  return false;
}

function parseConnectionInput(payload: unknown): ProviderConnectionInput {
  return parseApiRequest(providerConnectionRequestSchema, payload);
}
