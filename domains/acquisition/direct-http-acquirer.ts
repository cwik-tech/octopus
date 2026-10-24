import { whenDefined } from "../../core/optional-properties.js"
import { promises as dns, type LookupAddress } from "node:dns";
import { isIP } from "node:net";

import { Agent, fetch, type Dispatcher } from "undici";

import {
  browserUrlAllowed,
  isPublicWebHost,
  type BrowserAgentPolicy,
} from "../browser/browser-policy.js";
import type { AcquisitionProxyTransport } from "./acquisition-proxy.js";
import type {
  AcquisitionAttemptOutcome,
  AcquisitionChallengeType,
  ResearchWebErrorCode,
} from "./acquisition-types.js";
import {
  evaluateAcquisitionQuality,
  type AcquisitionQualityDecision,
  type AcquisitionQualityReport,
} from "./acquisition-quality.js";
import { canonicalizeSourceUrl } from "./acquisition-url.js";
import {
  buildSourceRepresentations,
  type SourceRepresentationDraft,
} from "./source-representations.js";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 20_000;
const ALLOWED_MEDIA_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xhtml+xml",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
  "text/html",
  "text/plain",
  "text/markdown",
  "text/xml",
]);
const DOCUMENT_MEDIA_TYPES = new Map<string, string>([
  ["application/pdf", ".pdf"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pptx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
  ],
] as const);
const DOCUMENT_EXTENSIONS = new Set(DOCUMENT_MEDIA_TYPES.values());

/**
 * The one DNS capability this class uses.
 *
 * Narrowed to the call it actually makes, so a substitute resolver has to
 * satisfy the same contract the connection later relies on: every candidate
 * address, in resolver order. `dns.lookup` satisfies it directly.
 */
export type AcquisitionAddressResolver = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: boolean },
) => Promise<readonly LookupAddress[]>;

export interface DirectHttpAcquirerOptions {
  readonly allowHttpLocalhost?: boolean;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly lookup?: AcquisitionAddressResolver;
}

export type DirectHttpAcquisitionResult =
  | {
      readonly ok: true;
      readonly kind: "text";
      readonly requestedUrl: string;
      readonly finalUrl: string;
      readonly canonicalUrl: string;
      readonly title?: string;
      readonly mediaType: string;
      readonly text: string;
      readonly rawSource: {
        readonly bytes: Uint8Array;
        readonly fileExtension: string;
        readonly mediaType: string;
      };
      readonly representations: SourceRepresentationDraft;
      readonly qualityReport: AcquisitionQualityReport;
      readonly httpStatus: number;
      readonly responseBytes: number;
    }
  | {
      readonly ok: true;
      readonly kind: "document";
      readonly requestedUrl: string;
      readonly finalUrl: string;
      readonly canonicalUrl: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
      readonly fileName: string;
      readonly httpStatus: number;
      readonly responseBytes: number;
    }
  | {
      readonly ok: false;
      readonly requestedUrl: string;
      readonly finalUrl?: string;
      readonly httpStatus?: number;
      readonly outcome: AcquisitionAttemptOutcome;
      readonly code: ResearchWebErrorCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly terminal: boolean;
      /** Present only when `outcome` is `challenge`. */
      readonly challengeType?: AcquisitionChallengeType;
    };

export class DirectHttpAcquirer {
  private readonly lookup: AcquisitionAddressResolver;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;

  constructor(private readonly options: DirectHttpAcquirerOptions = {}) {
    this.lookup = options.lookup ?? dns.lookup;
    this.timeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000),
    );
    this.maximumResponseBytes = Math.max(
      1_024,
      Math.min(
        options.maximumResponseBytes ?? MAX_RESPONSE_BYTES,
        MAX_RESPONSE_BYTES,
      ),
    );
  }

  async acquire(params: {
    readonly url: string;
    readonly policy: BrowserAgentPolicy;
    readonly signal?: AbortSignal;
    /**
     * Re-issues the read through an already-open proxy session.
     *
     * Absent is the ordinary path and keeps the DNS-pinned dispatcher. The
     * session is owned by the caller; this method never opens or closes one.
     */
    readonly transport?: AcquisitionProxyTransport;
  }): Promise<DirectHttpAcquisitionResult> {
    let requestedUrl: string;
    try {
      requestedUrl = canonicalizeSourceUrl(params.url);
    } catch (error) {
      return failure(
        params.url,
        "policy-denied",
        "domain_denied",
        messageOf(error),
        false,
        true,
      );
    }
    let currentUrl = requestedUrl;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      if (!this.urlAllowed(currentUrl, params.policy)) {
        return failure(
          requestedUrl,
          "policy-denied",
          "domain_denied",
          "The source URL is outside the web acquisition policy.",
          false,
          true,
          currentUrl,
        );
      }
      const target = new URL(currentUrl);
      if (params.transport && this.proxiedIpLiteral(target)) {
        return failure(
          requestedUrl,
          "policy-denied",
          "domain_denied",
          "A proxied source must be addressed by hostname, not by IP literal.",
          false,
          true,
          currentUrl,
        );
      }
      let addresses: readonly { address: string; family: number }[];
      try {
        // Runs on every hop, and on the proxied path too. The proxy resolves
        // the name itself, so this cannot be pinned to what it will use; it
        // still refuses a name that resolves anywhere private from here.
        addresses = await this.resolveAllowedAddresses(target);
      } catch (error) {
        return failure(
          requestedUrl,
          "policy-denied",
          "domain_denied",
          messageOf(error),
          false,
          true,
          currentUrl,
        );
      }
      // The caller's session when this is the proxied rung, otherwise an agent
      // pinned to the address just vetted. Only the pinned one is ours to close.
      let pinned: Agent | undefined;
      let dispatcher: Dispatcher;
      if (params.transport) {
        dispatcher = params.transport.dispatcher;
      } else {
        pinned = createPinnedAgent(target.hostname, addresses);
        dispatcher = pinned;
      }
      try {
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signal = params.signal
          ? AbortSignal.any([params.signal, timeoutSignal])
          : timeoutSignal;
        const response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          dispatcher,
          signal,
          headers: {
            accept: [
              "text/html",
              "application/xhtml+xml",
              "text/plain",
              "text/markdown",
              "application/json",
              "application/xml;q=0.9",
              "*/*;q=0.1",
            ].join(", "),
            "accept-encoding": "gzip, br, deflate",
            "user-agent": "Pipeline-Deep-Research/1.0",
          },
        });
        if (isRedirect(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirect === MAX_REDIRECTS) {
            return failure(
              requestedUrl,
              "failed",
              "internal",
              redirect === MAX_REDIRECTS
                ? "The source exceeded the redirect limit."
                : "The source returned a redirect without a location.",
              false,
              true,
              currentUrl,
              response.status,
            );
          }
          try {
            currentUrl = canonicalizeSourceUrl(
              new URL(location, currentUrl).toString(),
            );
          } catch {
            return failure(
              requestedUrl,
              "policy-denied",
              "domain_denied",
              "The source redirected to an unsafe URL.",
              false,
              true,
              currentUrl,
              response.status,
            );
          }
          continue;
        }
        const mediaType = normalizeMediaType(
          response.headers.get("content-type"),
        );
        const documentExtension = resolveDocumentExtension(
          mediaType,
          currentUrl,
        );
        if (!isAllowedMediaType(mediaType) && !documentExtension) {
          await response.body?.cancel();
          return failure(
            requestedUrl,
            "unsupported",
            "unsupported_content",
            `The source media type '${mediaType}' requires a native document parser or is unsupported.`,
            false,
            true,
            currentUrl,
            response.status,
          );
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > this.maximumResponseBytes
        ) {
          await response.body?.cancel();
          return failure(
            requestedUrl,
            "unsupported",
            "unsupported_content",
            "The source exceeded the acquisition size limit.",
            false,
            true,
            currentUrl,
            response.status,
          );
        }
        const body = await readBoundedBody(
          response.body as ReadableStream<Uint8Array> | null,
          this.maximumResponseBytes,
        );
        if (documentExtension) {
          const statusDecision = evaluateAcquisitionQuality({
            url: currentUrl,
            text: "Downloaded native document.",
            httpStatus: response.status,
            mediaType,
          });
          if (!statusDecision.usable) {
            return qualityFailure(
              requestedUrl,
              currentUrl,
              response.status,
              statusDecision,
            );
          }
          return {
            ok: true,
            kind: "document",
            requestedUrl,
            finalUrl: currentUrl,
            canonicalUrl: canonicalizeSourceUrl(currentUrl),
            mediaType,
            bytes: body,
            fileName: resolveDocumentFileName(
              response.headers.get("content-disposition"),
              currentUrl,
              documentExtension,
            ),
            httpStatus: response.status,
            responseBytes: body.byteLength,
          };
        }
        const decoded = new TextDecoder(
          resolveCharset(response.headers.get("content-type")),
          {
            fatal: false,
          },
        ).decode(body);
        const extracted = buildSourceRepresentations(
          decoded,
          mediaType,
          currentUrl,
        );
        const quality = evaluateAcquisitionQuality({
          ...whenDefined(extracted.title, (definedValue) => ({ title: definedValue })),
          url: currentUrl,
          text: extracted.markdown,
          httpStatus: response.status,
          mediaType,
          structuredRepresentationCount: extracted.structured.filter(
            (representation) => representation.kind !== "metadata",
          ).length,
          clientRenderedShell: extracted.clientRenderedShell,
        });
        if (!quality.usable) {
          return qualityFailure(
            requestedUrl,
            currentUrl,
            response.status,
            quality,
          );
        }
        return {
          ok: true,
          kind: "text",
          requestedUrl,
          finalUrl: currentUrl,
          canonicalUrl: canonicalizeSourceUrl(
            extracted.canonicalUrl ?? currentUrl,
          ),
          ...(extracted.title ? { title: extracted.title } : {}),
          mediaType,
          text: extracted.markdown,
          rawSource: {
            bytes: body,
            fileExtension: rawFileExtension(mediaType, currentUrl),
            mediaType,
          },
          representations: extracted,
          qualityReport: quality.report,
          httpStatus: response.status,
          responseBytes: body.byteLength,
        };
      } catch (error) {
        if (params.signal?.aborted) {
          return failure(
            requestedUrl,
            "cancelled",
            "cancelled",
            "Web acquisition was cancelled.",
            false,
            true,
            currentUrl,
          );
        }
        if (
          (error instanceof DOMException && error.name === "TimeoutError") ||
          (error instanceof Error &&
            /timed? ?out|timeout/iu.test(error.message))
        ) {
          return failure(
            requestedUrl,
            "timeout",
            "timeout",
            "The source did not respond before the acquisition timeout.",
            true,
            false,
            currentUrl,
          );
        }
        if (error instanceof ResponseLimitError) {
          return failure(
            requestedUrl,
            "unsupported",
            "unsupported_content",
            error.message,
            false,
            true,
            currentUrl,
          );
        }
        return failure(
          requestedUrl,
          "failed",
          "internal",
          "The source could not be acquired through direct HTTP.",
          true,
          false,
          currentUrl,
        );
      } finally {
        await pinned?.close();
      }
    }
    return failure(
      requestedUrl,
      "failed",
      "internal",
      "The source could not be acquired.",
      false,
      true,
      currentUrl,
    );
  }

  /** True when a proxied target is addressed by IP rather than by name. */
  private proxiedIpLiteral(url: URL): boolean {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    return isIP(host) !== 0 && !isAllowedTestLocalhost(url, this.options.allowHttpLocalhost);
  }

  private urlAllowed(value: string, policy: BrowserAgentPolicy): boolean {
    if (
      !policy.enabled ||
      !browserUrlAllowed(value, policy.domains, {
        ...whenDefined(this.options.allowHttpLocalhost, (definedValue) => ({ allowHttpLocalhost: definedValue })),
        restrictDomains: policy.restrictDomains,
      })
    ) {
      return false;
    }
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      isAllowedTestLocalhost(url, this.options.allowHttpLocalhost)
    );
  }

  private async resolveAllowedAddresses(
    url: URL,
  ): Promise<readonly { address: string; family: number }[]> {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (isAllowedTestLocalhost(url, this.options.allowHttpLocalhost)) {
      if (isIP(host)) return [{ address: host, family: isIP(host) }];
      const answers = await this.lookup(host, { all: true, verbatim: true });
      if (answers.length === 0)
        throw new Error("The source hostname did not resolve.");
      return answers;
    }
    if (isIP(host)) {
      if (!isPublicWebHost(host)) {
        throw new Error(
          "The source resolved to a private or reserved address.",
        );
      }
      return [{ address: host, family: isIP(host) }];
    }
    const answers = await this.lookup(host, { all: true, verbatim: true });
    if (
      answers.length === 0 ||
      answers.some((answer) => !isPublicWebHost(answer.address))
    ) {
      throw new Error(
        "The source resolved to a private, reserved, or mixed address set.",
      );
    }
    return answers;
  }
}

function createPinnedAgent(
  hostname: string,
  addresses: readonly { address: string; family: number }[],
): Agent {
  let cursor = 0;
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        const selected = addresses[cursor % addresses.length];
        if (!selected) {
          throw new Error(`The pinned agent for ${hostname} has no resolved address.`);
        }
        cursor += 1;
        // Node asks for every address at once when `autoSelectFamily` is on,
        // which it is by default from Node 20, and then expects the array
        // form. Answering with the single-address form makes it read an
        // undefined address and refuse to connect, which reaches this class as
        // an unexplained transport failure for every source addressed by name.
        if (options.all === true) {
          callback(null, [{ address: selected.address, family: selected.family }]);
          return;
        }
        callback(null, selected.address, selected.family);
      },
      servername: hostname,
    },
    headersTimeout: DEFAULT_TIMEOUT_MS,
    bodyTimeout: DEFAULT_TIMEOUT_MS,
  });
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        throw new ResponseLimitError(
          "The source exceeded the acquisition size limit.",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function normalizeMediaType(value: string | null): string {
  return (
    value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream"
  );
}

function rawFileExtension(mediaType: string, url: string): string {
  const mapped = new Map([
    ["application/json", ".json"],
    ["application/ld+json", ".json"],
    ["application/xhtml+xml", ".html"],
    ["application/xml", ".xml"],
    ["application/rss+xml", ".xml"],
    ["application/atom+xml", ".xml"],
    ["text/html", ".html"],
    ["text/markdown", ".md"],
    ["text/plain", ".txt"],
    ["text/xml", ".xml"],
  ]).get(mediaType);
  if (mapped) return mapped;
  const fromUrl = pathExtension(new URL(url).pathname);
  return fromUrl && /^\.[a-z0-9]{1,10}$/u.test(fromUrl) ? fromUrl : ".bin";
}

function isAllowedMediaType(value: string): boolean {
  return ALLOWED_MEDIA_TYPES.has(value) || value.startsWith("text/");
}

function resolveDocumentExtension(
  mediaType: string,
  url: string,
): string | null {
  const fromMediaType = DOCUMENT_MEDIA_TYPES.get(mediaType);
  if (fromMediaType) return fromMediaType;
  if (mediaType !== "application/octet-stream") return null;
  const extension = pathExtension(new URL(url).pathname);
  return DOCUMENT_EXTENSIONS.has(extension) ? extension : null;
}

function resolveDocumentFileName(
  contentDisposition: string | null,
  url: string,
  requiredExtension: string,
): string {
  const dispositionName = contentDisposition
    ?.match(/\bfilename\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu)
    ?.slice(1)
    .find(Boolean);
  const encodedUrlName =
    new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  let urlName = encodedUrlName;
  try {
    urlName = decodeURIComponent(encodedUrlName);
  } catch {
    // Preserve the encoded URL component when it is not valid percent-encoding.
  }
  const candidate =
    dispositionName || urlName || `document${requiredExtension}`;
  const base = candidate.replace(/[/\\\0]/gu, "-");
  return pathExtension(base) === requiredExtension
    ? base
    : `${base.replace(/\.[^.]*$/u, "") || "document"}${requiredExtension}`;
}

function pathExtension(value: string): string {
  const match = value.toLowerCase().match(/\.[a-z0-9]+$/u);
  return match?.[0] ?? "";
}

function resolveCharset(contentType: string | null): string {
  const match = contentType?.match(/\bcharset\s*=\s*"?([^";\s]+)/iu);
  const charset = match?.[1]?.toLowerCase();
  return charset === "utf-8" || charset === "utf8" || !charset
    ? "utf-8"
    : charset;
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function isAllowedTestLocalhost(
  url: URL,
  enabled: boolean | undefined,
): boolean {
  return Boolean(
    enabled &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname),
  );
}

function qualityFailure(
  requestedUrl: string,
  finalUrl: string,
  status: number,
  decision: Exclude<AcquisitionQualityDecision, { usable: true }>,
): DirectHttpAcquisitionResult {
  return failure(
    requestedUrl,
    decision.outcome,
    decision.code,
    decision.reason,
    decision.outcome === "failed" || decision.outcome === "timeout",
    decision.terminal,
    finalUrl,
    status,
    decision.challengeType,
  );
}

function failure(
  requestedUrl: string,
  outcome: AcquisitionAttemptOutcome,
  code: ResearchWebErrorCode,
  message: string,
  retryable: boolean,
  terminal: boolean,
  finalUrl?: string,
  httpStatus?: number,
  challengeType?: AcquisitionChallengeType,
): DirectHttpAcquisitionResult {
  return {
    ok: false,
    requestedUrl,
    ...(finalUrl ? { finalUrl } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    outcome,
    code,
    message,
    retryable,
    terminal,
    ...(challengeType ? { challengeType } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ResponseLimitError extends Error {}
