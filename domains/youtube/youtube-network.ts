/**
 * YouTube-specific network helpers.
 *
 * The Webshare transport these used to sit beside now lives in
 * `domains/proxy/`, because web-research acquisition shares it. Cookie
 * attachment and host matching stay here: they mean nothing off YouTube.
 */

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

export function createCookieFetch(
  baseFetch: typeof globalThis.fetch,
  cookieHeader?: string,
): typeof globalThis.fetch {
  if (!cookieHeader?.trim()) return baseFetch;
  return async (input, init) => {
    const url = requestUrl(input);
    if (!isYoutubeHost(url.hostname)) return baseFetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookieHeader);
    return baseFetch(input, { ...init, headers });
  };
}

export function isYoutubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "youtube.com" || host.endsWith(".youtube.com");
}
