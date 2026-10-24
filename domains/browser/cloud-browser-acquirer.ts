import puppeteer, { type ConnectOptions, type Page } from 'puppeteer-core'

import type { BrowserAcquiredEvidence } from './browser-manager.js'
import type { BrowserNetworkPolicy } from './browser-network-policy.js'
import type { BrowserAgentPolicy } from './browser-policy.js'
import { authorizeBrowserRequest } from './browser-request-authorization.js'
import type { BrowserUseSessionClient } from './browser-use-session-client.js'
import type {
  AcquisitionCloudBrowserRuntime,
  CloudSessionCleanup,
  CloudSessionFailure,
} from './cloud-browser-types.js'

/**
 * Reads one page through a provider-supplied browser.
 *
 * The session lifecycle belongs to `BrowserUseSessionClient`, which brackets
 * this work and guarantees the remote browser is released. What lives here is
 * the part that is specific to *reading a page*: connecting over CDP,
 * authorizing what the browser is allowed to fetch, and bounding every step.
 *
 * Authorization is deliberately not reimplemented. It calls the same
 * `authorizeBrowserRequest` that managed Chrome calls, on the same four
 * occasions — before anything is sent to the provider, on every main
 * navigation and redirect, on every http(s) subresource, and once more when the
 * navigation settles. A cloud adapter with its own copy of those rules is how a
 * third party ends up fetching an internal URL on our behalf.
 */

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
const DEFAULT_SETTLE_MS = 10_000
const DEFAULT_MAX_HTML_BYTES = 5 * 1_024 * 1_024
const DEFAULT_MAX_TEXT_BYTES = 2 * 1_024 * 1_024
/**
 * The bound on every individual CDP command.
 *
 * A remote browser can accept a command and never answer, and a page read that
 * hangs holds a billing session open. Puppeteer's `protocolTimeout` covers its
 * own commands, but the reads here are composed of several, so each one gets an
 * explicit bound of its own.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000
/** A title is a label, not a payload. */
const MAX_TITLE_BYTES = 2_048

/** Selects direct WebSocket control or Puppeteer's HTTP discovery path. */
export function browserConnectOptions(
  cdpUrl: string,
  protocolTimeout: number,
): ConnectOptions {
  const protocol = new URL(cdpUrl).protocol
  return protocol === 'http:' || protocol === 'https:'
    ? { browserURL: cdpUrl, protocolTimeout }
    : { browserWSEndpoint: cdpUrl, protocolTimeout }
}

export interface CloudBrowserAcquirerOptions {
  readonly sessionClient: BrowserUseSessionClient
  readonly networkPolicy: BrowserNetworkPolicy
  readonly navigationTimeoutMs?: number
  readonly connectTimeoutMs?: number
  /**
   * How long the page is left alone after it loads.
   *
   * The provider solves CAPTCHAs on its own with no flag to set and no signal
   * when it finishes; its documented advice is to stop driving the page and
   * look again. This window is that pause. It is not a guarantee, and nothing
   * downstream treats a page that survives it as "solved" — the ordinary
   * quality classifier still has to find usable evidence.
   */
  readonly settleMs?: number
  /** Bounds each individual page command. */
  readonly commandTimeoutMs?: number
  readonly maxHtmlBytes?: number
  readonly maxTextBytes?: number
  /** Injectable for tests that drive a browser this process did launch. */
  readonly connect?: (cdpUrl: string) => Promise<CloudBrowserConnection>
}

/**
 * The part of a connected browser this acquirer uses.
 *
 * Narrower than Puppeteer's `Browser`, which it is structurally satisfied by,
 * so a test can supply a stand-in without a cast.
 */
export interface CloudBrowserConnection {
  newPage(): Promise<Page>
  /**
   * Puppeteer's own `disconnect` returns a promise, so this does too.
   *
   * Narrowing it to `void` silently discarded a rejection, which surfaces later
   * as an unhandled promise rather than as the harmless cleanup failure it is.
   */
  disconnect(): void | Promise<void>
}

export interface CloudAcquisitionResult {
  readonly evidence?: BrowserAcquiredEvidence
  readonly failure?: CloudSessionFailure
  readonly runtime: AcquisitionCloudBrowserRuntime
  readonly cleanup: CloudSessionCleanup
}

export class CloudBrowserAcquirer {
  constructor(private readonly options: CloudBrowserAcquirerOptions) {}

  async acquire(
    url: string,
    policy: BrowserAgentPolicy,
    signal?: AbortSignal,
  ): Promise<CloudAcquisitionResult> {
    // Before anything is sent. Handing this URL to a third party is itself the
    // egress the policy governs, so a refused URL must not reach the provider
    // even as a string in a request body.
    //
    // A policy that cannot answer is not a policy that said yes: the throw is
    // caught here and fails closed, rather than escaping `acquire` as an
    // unexpected rejection its caller never contracted for.
    let permitted = false
    try {
      permitted = await this.options.networkPolicy.allows(url, policy)
    } catch {
      permitted = false
    }
    if (!permitted) {
      return {
        failure: {
          code: 'policy_denied',
          message: 'The URL is blocked by the agent domain policy.',
        },
        runtime: unusedRuntime(),
        cleanup: { stopped: true },
      }
    }

    // Owned here so a denial recorded inside the remote browser survives the
    // session bracket and can be reported as what it is.
    const denial: PolicyDenial = {}
    const outcome = await this.options.sessionClient.withSession(
      (session) => this.read(session.cdpUrl, url, policy, denial, signal),
      signal,
    )

    // A blocked navigation and a page that simply never loaded both surface as
    // a failed read. They are not the same event, and only one of them is a
    // policy decision the operator needs to see.
    const failure: CloudSessionFailure | undefined =
      denial.url && outcome.failure
        ? {
            code: 'policy_denied',
            message: 'Navigation was blocked by the agent domain policy.',
          }
        : outcome.failure

    return {
      ...(outcome.value ? { evidence: outcome.value } : {}),
      ...(failure ? { failure } : {}),
      runtime: outcome.runtime,
      cleanup: outcome.cleanup,
    }
  }

  private async read(
    cdpUrl: string,
    url: string,
    policy: BrowserAgentPolicy,
    denied: PolicyDenial,
    signal?: AbortSignal,
  ): Promise<BrowserAcquiredEvidence> {
    const connecting = this.connect(cdpUrl)
    // A withdrawal during the handshake must not leave the connection that
    // eventually arrives holding a socket to a session about to be stopped.
    const browser = await raceAbort(connecting, signal, () => {
      void releaseLateConnection(connecting)
    })
    let page: Page | undefined
    try {
      const command = this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
      page = await raceAbort(
        withTimeout(browser.newPage(), command, 'new page'),
        signal,
      )
      await raceAbort(this.enforcePolicy(page, policy, denied, command), signal)
      const timeout = this.options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS

      let httpStatus: number | undefined
      try {
        // Raced against the caller's signal. `page.goto` takes no AbortSignal,
        // so without this a withdrawal would hold the billing session open for
        // the whole navigation timeout before anyone noticed.
        const response = await raceAbort(
          page.goto(url, { waitUntil: 'domcontentloaded', timeout }),
          signal,
        )
        if (response) httpStatus = response.status()
      } catch (error) {
        if (denied.url) throw new Error(`Navigation was blocked by the agent domain policy.`)
        throw error
      }
      if (denied.url) throw new Error('Navigation was blocked by the agent domain policy.')

      await settle(this.options.settleMs ?? DEFAULT_SETTLE_MS, signal)
      // Settling ends early when the caller withdraws. Reading on regardless
      // would spend the remote session producing evidence nobody asked for any
      // more, and would report it as a successful acquisition.
      if (signal?.aborted) throw new Error('Cloud browser acquisition was cancelled.')

      // The page may have moved while we waited. Re-check where it actually is.
      const finalUrl = page.url()
      if (!(await this.options.networkPolicy.allows(finalUrl, policy))) {
        // Recorded, not just thrown: the caller reports a policy denial by the
        // presence of this, and a settled URL that drifted somewhere forbidden
        // is the same decision as a blocked redirect.
        denied.url = finalUrl
        throw new Error('The settled URL is blocked by the agent domain policy.')
      }

      const htmlLimit = this.options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES
      const textLimit = this.options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES
      const captured = parseInPageCapture(
        await withTimeout(
          page.evaluate(capturePageExpression(htmlLimit, textLimit)),
          command,
          'page capture',
        ),
        { htmlLimit, textLimit },
      )

      return {
        requestedUrl: url,
        finalUrl,
        ...(captured.title ? { title: captured.title } : {}),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        text: captured.text,
        renderedHtml: captured.html,
        renderedHtmlTruncated: captured.htmlTruncated,
      }
    } finally {
      if (page) {
        await withTimeout(
          page.close(),
          this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          'close',
        ).catch(() => undefined)
      }
      // Disconnect, never close: the browser belongs to the provider, and the
      // session client is what actually ends it. A failure to let go is not a
      // reason to lose an acquisition that already succeeded, and it is awaited
      // under a bound so a hanging disconnect cannot hold the result hostage.
      await withTimeout(
        Promise.resolve(browser.disconnect()),
        this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        'disconnect',
      ).catch(() => undefined)
    }
  }

  /**
   * Connects to the remote browser under an explicit bound.
   *
   * Puppeteer 25.3 exposes `protocolTimeout` for commands but nothing that
   * bounds the websocket handshake, so a provider that accepts a TCP connection
   * and then goes quiet would hang here forever. The race supplies the missing
   * bound, and the loser is disconnected rather than left holding a socket.
   */
  private async connect(cdpUrl: string): Promise<CloudBrowserConnection> {
    const connecting = this.options.connect
      ? this.options.connect(cdpUrl)
      : puppeteer.connect(
          browserConnectOptions(
            cdpUrl,
            this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          ),
        )
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

    let timer: NodeJS.Timeout | undefined
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('The cloud browser did not accept a control connection.')),
        timeoutMs,
      )
      timer.unref()
    })
    try {
      return await Promise.race([connecting, expiry])
    } catch (error) {
      void releaseLateConnection(connecting)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** The same interception managed Chrome installs, with the same rule. */
  private async enforcePolicy(
    page: Page,
    policy: BrowserAgentPolicy,
    denied: PolicyDenial,
    commandTimeoutMs: number,
  ): Promise<void> {
    await withTimeout(
      page.setRequestInterception(true),
      commandTimeoutMs,
      'request interception',
    )
    // Request interception covers the page it is installed on. It does not
    // cover a *new browsing context*, whose first request is issued before this
    // process can attach anything to it — measured, not assumed: closing a popup
    // on the `popup` event is far too late, and a `target=_blank` anchor never
    // calls `window.open` at all.
    //
    // So the default actions that create a new context are neutralised before a
    // single line of page script runs. Everything else — ordinary same-page
    // navigation, and the clicking a provider's CAPTCHA solver does — is
    // untouched and still authorized by interception.
    await withTimeout(
      page.evaluateOnNewDocument(newContextGuardExpression()),
      commandTimeoutMs,
      'new-context guard',
    )
    // A backstop only. If a context is somehow still created, closing it is
    // better than leaving it, but the guard above is what actually prevents the
    // request.
    page.on('popup', (popup) => {
      if (!popup) return
      void popup.close().catch(() => undefined)
    })
    // Verified, not assumed. `defineProperty` can fail on a property that is
    // already non-configurable, and the catch around each install would
    // otherwise let a page through with a guard that never took.
    //
    // The check runs on a *freshly navigated* blank document, because
    // `evaluateOnNewDocument` applies to documents created after it is
    // registered and the page's initial one predates it. A blank document runs
    // no site script, so nothing can forge the answer — which a check after the
    // real navigation could not promise, since a page can replace
    // `Object.getOwnPropertyDescriptor`.
    await withTimeout(page.goto('about:blank'), commandTimeoutMs, 'guard bootstrap')
    const installed = parseGuardReport(
      await withTimeout(page.evaluate(guardReportExpression()), commandTimeoutMs, 'guard check'),
    )
    if (!installed.every((entry) => entry.locked)) {
      const missing = installed.filter((entry) => !entry.locked).map((entry) => entry.name)
      throw new Error(
        `The cloud browser egress guard did not install: ${missing.join(', ')}.`,
      )
    }

    page.on('request', (request) => {
      void (async () => {
        try {
          const verdict = await authorizeBrowserRequest(
            {
              url: request.url(),
              isMainNavigation:
                request.isNavigationRequest() && request.frame() === page.mainFrame(),
            },
            policy,
            this.options.networkPolicy,
          )
          if (!verdict.blocked) {
            await request.continue().catch(() => undefined)
            return
          }
          if (verdict.mainNavigation) denied.url = request.url()
        } catch {
          // An authorization that could not be decided is not an authorization.
          // Falling through to the abort below both fails safe and resolves the
          // request, which an escaping rejection would leave hanging until the
          // navigation timed out.
        }
        await request.abort('blockedbyclient').catch(() => undefined)
      })()
    })
  }
}

/**
 * Neutralises the default actions that open a new browsing context.
 *
 * Installed before page script, and written against natives captured at that
 * moment, so a page that later rewrites `Object.defineProperty`,
 * `addEventListener` or the form prototypes cannot reach the copies this guard
 * holds. The properties it installs are non-writable and non-configurable, so
 * they cannot be deleted or replaced either.
 *
 * Deliberately narrow. It fires only when a `target` names a context other than
 * the current one, which leaves ordinary same-page clicks, form posts and a
 * provider's own CAPTCHA interactions working exactly as before.
 */
function newContextGuardExpression(): string {
  return `(function () {
    // Every native this guard will ever use, captured before page script runs,
    // and invoked through a captured Reflect.apply.
    //
    // \`captured.call(fn, ...)\` would not be enough: that still looks up the
    // \`call\` property at use time, so a page replacing Function.prototype.call
    // after startup would defeat every other capture at once. Reflect.apply is
    // held as a local binding and called directly, with no property access on
    // anything the page can reach.
    var invoke = Reflect.apply;
    var defineProperty = Object.defineProperty;
    var addEventListener = EventTarget.prototype.addEventListener;
    var getAttribute = Element.prototype.getAttribute;
    var hasAttribute = Element.prototype.hasAttribute;
    var getElementsByTagName = Document.prototype.getElementsByTagName;
    var composedPath = Event.prototype.composedPath;
    var preventDefault = Event.prototype.preventDefault;
    var indexOf = Array.prototype.indexOf;
    var toLowerCase = String.prototype.toLowerCase;
    var toUpperCase = String.prototype.toUpperCase;
    var toText = String;
    var nativeSubmit = HTMLFormElement.prototype.submit;
    var nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    var ownDocument = document;

    function lower(value) { return invoke(toLowerCase, toText(value), []); }
    function upper(value) { return invoke(toUpperCase, toText(value), []); }

    function attribute(node, name) {
      try {
        if (!invoke(hasAttribute, node, [name])) return null;
        return invoke(getAttribute, node, [name]);
      } catch (error) {
        // An element that will not answer is treated as hostile.
        return '_blank';
      }
    }

    function opensNewContext(value) {
      if (value === null || value === undefined) return false;
      var name = lower(value);
      return name !== '' && name !== '_self' && name !== '_top' && name !== '_parent';
    }

    /**
     * The first base element that actually carries a target.
     *
     * HTML resolves the target from the first base *with a target attribute*,
     * not from the first base element, so a leading href-only base would
     * otherwise hide a later targeting one.
     */
    function baseTarget() {
      try {
        var bases = invoke(getElementsByTagName, ownDocument, ['base']);
        if (!bases) return null;
        for (var index = 0; index < bases.length; index += 1) {
          var value = attribute(bases[index], 'target');
          if (value !== null && toText(value) !== '') return value;
        }
        return null;
      } catch (error) {
        return null;
      }
    }

    function effectiveTarget(own) {
      if (own !== null && own !== undefined && toText(own) !== '') return own;
      return baseTarget();
    }

    function pathOf(event) {
      try {
        return invoke(composedPath, event, []) || [];
      } catch (error) {
        return [];
      }
    }

    function stop(event) {
      try {
        invoke(preventDefault, event, []);
      } catch (error) {
        // Nothing further to try; the default action is the risk, not the throw.
      }
    }

    function targetedAncestor(event, tags) {
      var path = pathOf(event);
      for (var index = 0; index < path.length; index += 1) {
        var node = path[index];
        if (!node || !node.tagName) continue;
        if (invoke(indexOf, tags, [upper(node.tagName)]) === -1) continue;
        if (opensNewContext(effectiveTarget(attribute(node, 'target')))) return node;
      }
      return null;
    }

    defineProperty(window, 'open', {
      value: function () { return null; },
      writable: false, configurable: false
    });

    // Network paths that do **not** travel through page request interception.
    //
    // Measured against a real Chrome and a trap origin, before and after:
    // a dedicated Worker's *fetch* is intercepted, but a ServiceWorker's fetch,
    // a WebSocket handshake, a WebSocket opened *inside* a Worker, and a
    // SharedWorker all reached the network unauthorized.
    //
    // The worker cases are why worker construction itself is removed rather
    // than the transports inside it: this guard runs in Window, and a worker
    // has its own global scope that it never touches.
    //
    // Impact, stated plainly: a site relying on a ServiceWorker for offline
    // content, on a WebSocket for live updates, or on a worker for rendering
    // will render without them. Static content and ordinary HTTP are untouched,
    // and same-page clicking — what a provider's CAPTCHA solver does — is
    // explicitly tested as unaffected. **If a solver is ever found to need one
    // of these, the answer is interception at the browser CDP boundary, not
    // re-opening the hole.**
    var blocked = function () {
      throw new TypeError('This transport is not available.');
    };
    for (var name of [
      'WebSocket', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection',
      'Worker', 'SharedWorker',
    ]) {
      if (name in window) {
        try {
          defineProperty(window, name, {
            value: blocked, writable: false, configurable: false
          });
        } catch (error) {
          // Already non-configurable; nothing further to do.
        }
      }
    }
    try {
      defineProperty(Navigator.prototype, 'serviceWorker', {
        get: function () { return undefined; },
        configurable: false
      });
    } catch (error) {
      // Leave it; the probe below is what tells us whether this held.
    }

    invoke(addEventListener, window, ['click', function (event) {
      if (targetedAncestor(event, ['A', 'AREA'])) stop(event);
    }, true]);

    invoke(addEventListener, window, ['submit', function (event) {
      if (targetedAncestor(event, ['FORM'])) { stop(event); return; }
      var submitter = event.submitter;
      if (submitter && opensNewContext(effectiveTarget(attribute(submitter, 'formtarget')))) {
        stop(event);
      }
    }, true]);

    function submissionTarget(form, submitter) {
      if (submitter) {
        var override = attribute(submitter, 'formtarget');
        if (override !== null && toText(override) !== '') return effectiveTarget(override);
      }
      return effectiveTarget(attribute(form, 'target'));
    }

    function guarded(original) {
      return function (submitter) {
        if (opensNewContext(submissionTarget(this, submitter))) return undefined;
        return invoke(original, this, arguments);
      };
    }

    defineProperty(HTMLFormElement.prototype, 'submit', {
      value: guarded(nativeSubmit), writable: false, configurable: false
    });
    if (nativeRequestSubmit) {
      defineProperty(HTMLFormElement.prototype, 'requestSubmit', {
        value: guarded(nativeRequestSubmit), writable: false, configurable: false
      });
    }
  })()`
}

/**
 * Reports whether each guarded entry is actually in force.
 *
 * Exported so a test can run it against a page the guard was never applied to
 * and confirm it says so — a check that only ever reports success is not a check.
 *
 * The window entries are judged by their descriptor because the natives they
 * replace are all writable and configurable, so a non-writable,
 * non-configurable own property is only there because the guard put it there.
 * The transports are additionally required to share one function identity,
 * which is what distinguishes "replaced by this guard" from "locked by
 * something else".
 *
 * `serviceWorker` cannot be judged that way. Its native lives on
 * `Navigator.prototype` as an accessor that may already be non-configurable, in
 * which case the guard's `defineProperty` throws, is caught, and leaves
 * `navigator.serviceWorker` perfectly usable — while a descriptor-only check
 * happily reports it locked. So it is judged by what it does.
 */
export function guardReportExpression(): string {
  return `(function () {
    var report = [];
    var blocked = [
      'WebSocket', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection',
      'Worker', 'SharedWorker'
    ];
    var replacement = null;
    for (var index = 0; index < blocked.length; index += 1) {
      var name = blocked[index];
      if (!(name in window)) continue;
      var descriptor = Object.getOwnPropertyDescriptor(window, name);
      var owned = !!descriptor &&
        descriptor.writable === false &&
        descriptor.configurable === false;
      // Every blocked transport is the same function object, so one that is
      // merely locked by something else does not pass.
      if (replacement === null) replacement = window[name];
      report.push({
        name: name,
        locked: owned && window[name] === replacement && typeof replacement === 'function'
      });
    }
    var openDescriptor = Object.getOwnPropertyDescriptor(window, 'open');
    report.push({
      name: 'open',
      locked: !!openDescriptor &&
        openDescriptor.writable === false &&
        openDescriptor.configurable === false
    });
    for (var formIndex = 0; formIndex < 2; formIndex += 1) {
      var member = formIndex === 0 ? 'submit' : 'requestSubmit';
      if (!(member in HTMLFormElement.prototype)) continue;
      var formDescriptor = Object.getOwnPropertyDescriptor(
        HTMLFormElement.prototype, member
      );
      report.push({
        name: 'HTMLFormElement.' + member,
        locked: !!formDescriptor &&
          formDescriptor.writable === false &&
          formDescriptor.configurable === false
      });
    }
    var serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      Navigator.prototype, 'serviceWorker'
    );
    report.push({
      name: 'serviceWorker',
      // Behaviour first: the property must actually read as undefined. A
      // non-configurable native getter would satisfy a descriptor check while
      // handing the page a working ServiceWorker container.
      locked: navigator.serviceWorker === undefined &&
        !!serviceWorkerDescriptor &&
        serviceWorkerDescriptor.configurable === false
    });
    return report;
  })()`
}

/** Validates the guard report, which is page output like any other. */
export function parseGuardReport(
  value: unknown,
): readonly { readonly name: string; readonly locked: boolean }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('The cloud browser egress guard could not be verified.')
  }
  return value.map((entry) => {
    if (!isGuardReportEntry(entry)) {
      throw new Error('The cloud browser egress guard could not be verified.')
    }
    return { name: entry.name, locked: entry.locked }
  })
}

/** Narrows one report row before any of its fields are read. */
function isGuardReportEntry(
  value: unknown,
): value is { readonly name: string; readonly locked: boolean } {
  if (!isPlainRecord(value)) return false
  return typeof value.name === 'string' && typeof value.locked === 'boolean'
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The capture, as source text evaluated inside the page.
 *
 * Sent as an expression rather than a function reference on purpose. Puppeteer
 * serializes a passed function with `toString()`, and this project's TypeScript
 * transform rewrites named functions to reference a helper that does not exist
 * in the page — which fails at runtime as a bare `ReferenceError` with nothing
 * to point at. A self-contained expression cannot be broken that way.
 *
 * Cutting here keeps an enormous page off the wire in the ordinary case, which
 * is what it is for. It is **not** the security boundary: this runs in the
 * page's own realm, where site script can replace `TextEncoder` and return
 * whatever it likes, and Puppeteer 25.3 exposes no isolated realm on its public
 * `Frame` type to escape that. The budget is therefore enforced again by
 * `parseInPageCapture` on this side, where no page script can reach it, and
 * that host-side bound is the one the guarantee rests on.
 *
 * The cut is UTF-8 correct. Slicing a JavaScript string cuts UTF-16 code units,
 * which both mis-measures the byte budget and can split a character in half;
 * this walks back off any continuation byte so the result always decodes.
 *
 * Both limits are integers this process computed, so interpolating them carries
 * nothing from the page or the provider into the source.
 */
function capturePageExpression(htmlLimit: number, textLimit: number): string {
  const html = Math.max(0, Math.floor(htmlLimit))
  const text = Math.max(0, Math.floor(textLimit))
  return `(() => {
    var encoder = new TextEncoder();
    var decoder = new TextDecoder();
    var take = function (value, limit) {
      var bytes = encoder.encode(value);
      if (bytes.length <= limit) return { text: value, truncated: false };
      var end = limit;
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    };
    var htmlPart = take(document.documentElement ? document.documentElement.outerHTML : '', ${html});
    var textPart = take(document.body ? document.body.innerText : '', ${text});
    var titlePart = take(document.title || '', ${MAX_TITLE_BYTES});
    return {
      html: htmlPart.text,
      htmlTruncated: htmlPart.truncated,
      text: textPart.text,
      title: titlePart.text
    };
  })()`
}

/**
 * Validates what the page handed back.
 *
 * The page is provider- and site-controlled, so its return value is external
 * input like any other. A page that overrides `TextEncoder` could return
 * anything at all, and the shape is checked before a single field is used.
 */
export function parseInPageCapture(
  value: unknown,
  limits: { readonly htmlLimit: number; readonly textLimit: number },
): {
  readonly html: string
  readonly htmlTruncated: boolean
  readonly text: string
  readonly title: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The cloud browser returned an unusable page capture.')
  }
  const record: Record<string, unknown> = { ...value }
  const html = record.html
  const text = record.text
  const title = record.title
  const htmlTruncated = record.htmlTruncated
  if (
    typeof html !== 'string' ||
    typeof text !== 'string' ||
    typeof title !== 'string' ||
    typeof htmlTruncated !== 'boolean'
  ) {
    throw new Error('The cloud browser returned an unusable page capture.')
  }
  // The in-page cut is what keeps a huge payload off the wire, but the page is
  // the one thing here we do not control. The budget is therefore enforced
  // again on this side, where no page script can reach it.
  const boundedHtml = boundUtf8(html, limits.htmlLimit)
  const boundedText = boundUtf8(text, limits.textLimit)
  return {
    html: boundedHtml.value,
    htmlTruncated: htmlTruncated || boundedHtml.truncated,
    text: boundedText.value,
    title: boundUtf8(title, MAX_TITLE_BYTES).value,
  }
}

/** Cuts to a byte budget on a character boundary. */
function boundUtf8(
  value: string,
  maximumBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.byteLength <= maximumBytes) return { value, truncated: false }
  let end = Math.max(0, Math.floor(maximumBytes))
  while (end > 0 && ((buffer.at(end) ?? 0) & 0xc0) === 0x80) end -= 1
  return { value: buffer.subarray(0, end).toString('utf8'), truncated: true }
}

/**
 * Races work against the caller's withdrawal.
 *
 * The loser is not cancelled — it cannot be — but the caller stops waiting for
 * it, which is what lets cleanup begin while a slow navigation is still running.
 */
async function raceAbort<T>(
  work: Promise<T>,
  signal?: AbortSignal,
  onWithdrawal?: () => void,
): Promise<T> {
  if (!signal) return work
  let onAbort = (): void => undefined
  const withdrawal = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Cloud browser acquisition was cancelled.'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, withdrawal])
  } catch (error) {
    void work.catch(() => undefined)
    onWithdrawal?.()
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Records a main-navigation URL the policy refused inside the remote browser. */
interface PolicyDenial {
  url?: string
}

function unusedRuntime(): AcquisitionCloudBrowserRuntime {
  return {
    provider: 'browser-use',
    proxyCountry: 'none',
    browserCostMicros: 0,
    proxyCostMicros: 0,
    proxyUsedMilliMb: 0,
    sessionStatus: 'unknown',
    meterSource: 'unavailable',
  }
}

/**
 * Bounds one page command.
 *
 * The losing promise is deliberately swallowed rather than left unhandled: a
 * command that answers after its deadline is no longer interesting, but an
 * unhandled rejection from it would take the process down.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The cloud browser did not answer the ${label} read.`)),
      ms,
    )
    timer.unref()
  })
  try {
    return await Promise.race([work, expiry])
  } catch (error) {
    void work.catch(() => undefined)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Releases a connection that arrived after nobody was waiting for it.
 *
 * Without this a handshake that lost its race, or completed after the caller
 * withdrew, would sit holding a socket to a session we are about to stop.
 */
async function releaseLateConnection(
  connecting: Promise<CloudBrowserConnection>,
): Promise<void> {
  try {
    const browser = await connecting
    await browser.disconnect()
  } catch {
    // The connection never arrived, or would not let go. Either way there is
    // nothing further to release here.
  }
}

async function settle(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    timer.unref()
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}
