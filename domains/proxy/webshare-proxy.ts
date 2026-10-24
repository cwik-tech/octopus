import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

import type { AcquisitionProxyRuntime } from "../acquisition/acquisition-types.js";
import { parseWebshareCredentials } from "./webshare-credentials.js";
import type { WebshareRuntimeConfig } from "./webshare-settings.js";

const WEBSHARE_CONFIG_URL = "https://proxy.webshare.io/api/v2/proxy/config/";
const WEBSHARE_VALIDATION_URL = "https://ipv4.webshare.io/";
const WEBSHARE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The same proxy, addressed the way a browser needs it.
 *
 * Parent-process-only. Chrome refuses credentials inside a proxy argument and
 * answers a 407 challenge instead, so `server` carries no userinfo and the pair
 * is handed to the browser's own authentication call. It is derived here, with
 * the credentials, so it cannot drift from the URL `proxyUrl` dials.
 */
export interface ResolvedWebshareBrowserEndpoint {
  /** `scheme://host:port`, with no userinfo. */
  readonly server: string;
  readonly username: string;
  readonly password: string;
}

export interface ResolvedWebshareProxy {
  readonly proxyUrl: URL;
  readonly username: string;
  readonly browserEndpoint: ResolvedWebshareBrowserEndpoint;
  readonly close: () => Promise<void>;
  readonly fetch: typeof globalThis.fetch;
  /** The single agent behind `fetch`, for callers that dispatch directly. */
  readonly dispatcher: Dispatcher;
}

export async function resolveWebshareProxy(
  config: WebshareRuntimeConfig,
  signal?: AbortSignal,
): Promise<ResolvedWebshareProxy | undefined> {
  if (!config.proxyEnabled) return undefined;
  const credentials =
    config.credentialMode === "api-token"
      ? await resolveCredentialsFromApiToken(
          requireSecret(config.apiToken, "Webshare API token"),
          signal,
        )
      : {
          username: requireSecret(config.username, "Webshare username"),
          password: requireSecret(config.password, "Webshare password"),
        };
  const username = targetedUsername(credentials.username, config.countries);
  const proxyUrl = new URL(`http://${config.proxyHost}:${config.proxyPort}`);
  proxyUrl.username = username;
  proxyUrl.password = credentials.password;
  const dispatcher = new ProxyAgent(proxyUrl.toString());
  return {
    proxyUrl,
    username,
    browserEndpoint: {
      server: `${proxyUrl.protocol}//${config.proxyHost}:${config.proxyPort}`,
      username,
      password: credentials.password,
    },
    dispatcher,
    fetch: createDispatcherFetch(dispatcher),
    close: () => dispatcher.close(),
  };
}

export async function validateWebshareProxy(
  config: WebshareRuntimeConfig,
  signal?: AbortSignal,
): Promise<void> {
  const resolved = await resolveWebshareProxy(config, signal);
  if (!resolved) throw new Error("Webshare proxy is disabled.");
  try {
    const response = await resolved.fetch(WEBSHARE_VALIDATION_URL, {
      method: "GET",
      redirect: "error",
      signal: withDeadline(signal),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error("Webshare proxy validation failed.");
  } finally {
    await resolved.close().catch(() => undefined);
  }
}

/**
 * The proxy an attempt went through, as this application configures it.
 *
 * `mode` is `rotating` because `targetedUsername` selects a rotating endpoint.
 * `tier` is `unknown` and must stay that way: nothing here establishes whether
 * the account's exits are datacenter or residential, and a guess would make a
 * measurement compare the guess instead of the proxy.
 */
export const WEBSHARE_PROXY_RUNTIME: AcquisitionProxyRuntime = Object.freeze({
  provider: "webshare",
  mode: "rotating",
  tier: "unknown",
});

export function targetedUsername(
  baseUsername: string,
  countries: readonly string[],
): string {
  const username = baseUsername.trim();
  const suffix = countries.map((country) => country.toLowerCase()).join("-");
  if (!suffix) return username;
  if (username.toLowerCase().endsWith("-rotate")) return username;
  return `${username}-${suffix}-rotate`;
}

function createDispatcherFetch(
  dispatcher: Dispatcher,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const response = await undiciFetch(request.url, {
      body: request.body,
      dispatcher,
      headers: [...request.headers.entries()],
      method: request.method,
      redirect: request.redirect,
      signal: request.signal,
    });
    return new Response(toWebReadableStream(response.body), {
      headers: [...response.headers.entries()],
      status: response.status,
      statusText: response.statusText,
    });
  };
}

function toWebReadableStream(
  body: Awaited<ReturnType<typeof undiciFetch>>["body"],
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // undici types the body as ReadableStream<any>; a fetch body yields bytes.
      const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      await body.cancel(reason);
    },
  });
}

async function resolveCredentialsFromApiToken(
  apiToken: string,
  signal?: AbortSignal,
): Promise<{ username: string; password: string }> {
  const response = await fetch(WEBSHARE_CONFIG_URL, {
    method: "GET",
    headers: { authorization: `Token ${apiToken}` },
    redirect: "error",
    signal: withDeadline(signal),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Webshare API token validation failed.");
  }
  return parseWebshareCredentials(await response.json());
}

function requireSecret(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function withDeadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(WEBSHARE_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
