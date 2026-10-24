import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import { evaluateAcquisitionQuality } from '../../domains/acquisition/acquisition-quality.js'
import { buildSourceRepresentations } from '../../domains/acquisition/source-representations.js'
import type {
  AcquisitionAttemptOutcome,
  AcquisitionChallengeType,
  BrowserLaunchProfile,
} from '../../domains/acquisition/acquisition-types.js'
import puppeteer from 'puppeteer-core'

import { resolveBrowserExecutablePath } from '../../domains/browser/browser-executable.js'
import {
  BrowserManager,
  BrowserRuntimeError,
  launchArguments,
  type BrowserExecutionScope,
} from '../../domains/browser/browser-manager.js'

/**
 * The Phase 1 local browser bake-off.
 *
 * It compares local Chrome builds against each other at the acquisition
 * boundary, which is the only place the launch profile can change an outcome.
 * The ladder above it - the direct rung, the proxy, the managed reader - is
 * deliberately absent, because a difference measured through them could come
 * from any of them.
 *
 * Nothing here asserts anything about a public site. It produces records; a
 * caller decides what, if anything, they mean.
 *
 * No page text, query string, fragment, cookie, or error body enters a record.
 * A gated target reports one boolean: whether its protected content unlocked.
 */

export type CountermeasureVariant =
  | BrowserLaunchProfile
  /** The stock profile, read twice inside one assignment context. */
  | 'warm-assignment'

export interface CountermeasureTarget {
  readonly host: string
  /** A URL with no userinfo, query, or fragment. */
  readonly probeUrl: string
  /**
   * A literal that only appears once the target's gate has been passed.
   *
   * Present for deterministic targets alone. Loading a widget is not passing a
   * gate, so the harness never treats a rendered challenge as a success.
   */
  readonly protectedContentLiteral?: string
}

export type CountermeasureStatus = 'tested' | 'skipped' | 'timed-out' | 'untested'

export interface CountermeasureRecord {
  readonly runId: string
  readonly startedAt: string
  readonly variant: CountermeasureVariant
  readonly launchProfile: BrowserLaunchProfile
  readonly readsInAssignment: number
  readonly targetHost: string
  readonly targetUrl: string
  readonly driverVersion: string
  readonly browserVersion: string
  readonly mode: 'headed' | 'headless'
  readonly method: 'managed-browser'
  readonly proxyMode: 'none'
  readonly proxyTier: 'none'
  readonly status: CountermeasureStatus
  readonly outcome: AcquisitionAttemptOutcome | 'not-attempted'
  readonly challengeType?: AcquisitionChallengeType
  readonly httpStatus?: number
  readonly durationMs: number
  readonly protectedContentUnlocked: boolean
  /** A typed reason. Never a provider message or page text. */
  readonly reason?: string
}

export interface CountermeasureVariantSample {
  readonly variant: CountermeasureVariant
  readonly testedPairs: number
  /** Fewer than ten tested target-attempt pairs is not a measurement. */
  readonly insufficientSample: boolean
}

export interface CountermeasureAccounting {
  readonly tested: number
  readonly skipped: number
  readonly timedOut: number
  readonly untested: number
}

export interface CountermeasureRunReport {
  readonly runId: string
  readonly startedAt: string
  readonly finishedAt: string
  /** The order variants ran in, rotated between runs to blunt ordering bias. */
  readonly variantOrder: readonly CountermeasureVariant[]
  readonly targetCount: number
  readonly records: readonly CountermeasureRecord[]
  readonly variantSamples: readonly CountermeasureVariantSample[]
  readonly accounting: CountermeasureAccounting
}

export interface CountermeasureRunOptions {
  readonly variants: readonly CountermeasureVariant[]
  readonly targets: readonly CountermeasureTarget[]
  readonly timeoutMs: number
  readonly allowHttpLocalhost?: boolean
  /** How far to rotate `variants` before running. Defaults to the wall clock. */
  readonly variantRotation?: number
  /** Targets past this index are recorded `untested` rather than dropped. */
  readonly targetLimit?: number
  readonly signal?: AbortSignal
}

const MINIMUM_COMPARABLE_PAIRS = 10

/** The launched browser's identity, constant for one variant's whole run. */
interface BrowserRuntimeFacts {
  readonly driverVersion: string
  readonly browserVersion: string
  readonly mode: 'headed' | 'headless'
}

export async function runCountermeasureBakeOff(
  options: CountermeasureRunOptions,
): Promise<CountermeasureRunReport> {
  const runId = randomUUID()
  const startedAt = new Date().toISOString()
  const variantOrder = rotate(
    options.variants,
    options.variantRotation ?? Math.floor(Date.now() / 1_000),
  )
  const limit = options.targetLimit ?? options.targets.length
  const attempted = options.targets.slice(0, Math.max(0, limit))
  const untested = options.targets.slice(Math.max(0, limit))
  const records: CountermeasureRecord[] = []

  for (const variant of variantOrder) {
    const launchProfile: BrowserLaunchProfile =
      variant === 'automation-controlled-disabled'
        ? 'automation-controlled-disabled'
        : 'stock'
    const readsInAssignment = variant === 'warm-assignment' ? 2 : 1
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), `browser-countermeasure-${variant}-`),
    )
    const manager = new BrowserManager({
      profilePath: path.join(root, 'profile'),
      mode: 'headless',
      launchProfile,
      ...(options.allowHttpLocalhost === true
        ? { allowHttpLocalhost: true }
        : {}),
    })
    try {
      // One host at a time, in one browser, on purpose. A public target must
      // never see this harness open several connections at once.
      //
      // The runtime is a property of the browser this variant launched, not of
      // any one read, so carrying it across targets describes the same Chrome
      // rather than inventing one for a read that failed before it could ask.
      let variantRuntime: BrowserRuntimeFacts | undefined
      for (const target of attempted) {
        const record = await measureTarget({
          manager,
          assignmentPath: root,
          runId,
          variant,
          launchProfile,
          readsInAssignment,
          target,
          timeoutMs: options.timeoutMs,
          ...(variantRuntime ? { knownRuntime: variantRuntime } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })
        if (record.browserVersion !== 'unknown') {
          variantRuntime = {
            driverVersion: record.driverVersion,
            browserVersion: record.browserVersion,
            mode: record.mode,
          }
        }
        records.push(record)
      }
    } finally {
      await manager.close().catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    }

    for (const target of untested) {
      records.push(
        notAttempted({
          runId,
          variant,
          launchProfile,
          readsInAssignment,
          target,
          status: 'untested',
          reason: 'target-limit',
        }),
      )
    }
  }

  const variantSamples = variantOrder.map((variant) => {
    const testedPairs = records.filter(
      (record) => record.variant === variant && record.status === 'tested',
    ).length
    return {
      variant,
      testedPairs,
      insufficientSample: testedPairs < MINIMUM_COMPARABLE_PAIRS,
    }
  })

  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    variantOrder,
    targetCount: options.targets.length,
    records,
    variantSamples,
    accounting: {
      tested: records.filter((record) => record.status === 'tested').length,
      skipped: records.filter((record) => record.status === 'skipped').length,
      timedOut: records.filter((record) => record.status === 'timed-out').length,
      untested: records.filter((record) => record.status === 'untested').length,
    },
  }
}

async function measureTarget(input: {
  readonly manager: BrowserManager
  readonly assignmentPath: string
  readonly runId: string
  readonly variant: CountermeasureVariant
  readonly launchProfile: BrowserLaunchProfile
  readonly readsInAssignment: number
  readonly target: CountermeasureTarget
  readonly timeoutMs: number
  readonly knownRuntime?: BrowserRuntimeFacts
  readonly signal?: AbortSignal
}): Promise<CountermeasureRecord> {
  const startedAt = new Date().toISOString()
  const began = Date.now()
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort()
  input.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const scope: BrowserExecutionScope = {
    sessionId: `countermeasure-${input.runId}`,
    runId: input.runId,
    // One assignment per variant, so the warm read reuses the same context.
    assignmentId: `assignment-${input.variant}`,
    activityScopeId: `lane-${input.variant}`,
    assignmentPath: input.assignmentPath,
    policy: { enabled: true, restrictDomains: false, domains: [] },
  }

  let runtime: BrowserRuntimeFacts = input.knownRuntime ?? {
    driverVersion: 'unknown',
    browserVersion: 'unknown',
    mode: 'headless',
  }
  let outcome: AcquisitionAttemptOutcome | 'not-attempted' = 'not-attempted'
  let status: CountermeasureStatus = 'tested'
  let challengeType: AcquisitionChallengeType | undefined
  let httpStatus: number | undefined
  let unlocked = false
  let reason: string | undefined

  try {
    let text = ''
    for (let read = 0; read < input.readsInAssignment; read += 1) {
      const acquired = await input.manager.acquireEvidence(
        scope,
        input.target.probeUrl,
        controller.signal,
      )
      if (acquired.browserRuntime) runtime = acquired.browserRuntime
      httpStatus = acquired.httpStatus
      const representations = buildSourceRepresentations(
        acquired.renderedHtml,
        'text/html',
        acquired.finalUrl,
      )
      text = representations.markdown || acquired.text
      const quality = evaluateAcquisitionQuality({
        ...(acquired.title ? { title: acquired.title } : {}),
        url: acquired.finalUrl,
        text,
        ...(acquired.httpStatus === undefined
          ? {}
          : { httpStatus: acquired.httpStatus }),
        mediaType: 'text/html',
        structuredRepresentationCount: representations.structured.filter(
          (representation) => representation.kind !== 'metadata',
        ).length,
        clientRenderedShell: representations.clientRenderedShell,
      })
      outcome = quality.usable ? 'usable' : quality.outcome
      challengeType = quality.usable ? undefined : quality.challengeType
    }
    unlocked = Boolean(
      input.target.protectedContentLiteral &&
      text.includes(input.target.protectedContentLiteral),
    )
  } catch (error) {
    if (error instanceof BrowserRuntimeError) {
      if (error.browserRuntime) runtime = error.browserRuntime
      httpStatus = error.page?.httpStatus
      challengeType = error.challengeType
      outcome = browserErrorOutcome(error.code)
      // A typed code, never the message: a provider or page can write anything
      // into a message, and this artifact is meant to be shareable.
      reason = error.code
      if (error.code === 'timeout' || error.code === 'cancelled') {
        status = controller.signal.aborted && !input.signal?.aborted
          ? 'timed-out'
          : 'skipped'
      }
    } else {
      // A raw Chrome navigation failure reaches here untyped. The target was
      // still attempted and still produced a comparable result, so it stays
      // `tested`; only Chrome's own error class is kept, because the rest of
      // the message quotes the address it was working on.
      outcome = 'failed'
      reason = chromeNetErrorToken(error) ?? 'unexpected-error'
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onCallerAbort)
  }

  return {
    runId: input.runId,
    startedAt,
    variant: input.variant,
    launchProfile: input.launchProfile,
    readsInAssignment: input.readsInAssignment,
    targetHost: input.target.host,
    targetUrl: input.target.probeUrl,
    driverVersion: runtime.driverVersion,
    browserVersion: runtime.browserVersion,
    mode: runtime.mode,
    method: 'managed-browser',
    proxyMode: 'none',
    proxyTier: 'none',
    status,
    outcome,
    ...(challengeType ? { challengeType } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    durationMs: Math.max(0, Date.now() - began),
    protectedContentUnlocked: unlocked,
    ...(reason ? { reason } : {}),
  }
}

function notAttempted(input: {
  readonly runId: string
  readonly variant: CountermeasureVariant
  readonly launchProfile: BrowserLaunchProfile
  readonly readsInAssignment: number
  readonly target: CountermeasureTarget
  readonly status: CountermeasureStatus
  readonly reason: string
}): CountermeasureRecord {
  return {
    runId: input.runId,
    startedAt: new Date().toISOString(),
    variant: input.variant,
    launchProfile: input.launchProfile,
    readsInAssignment: input.readsInAssignment,
    targetHost: input.target.host,
    targetUrl: input.target.probeUrl,
    driverVersion: 'unknown',
    browserVersion: 'unknown',
    mode: 'headless',
    method: 'managed-browser',
    proxyMode: 'none',
    proxyTier: 'none',
    status: input.status,
    outcome: 'not-attempted',
    durationMs: 0,
    protectedContentUnlocked: false,
    reason: input.reason,
  }
}

/**
 * Chrome's own error class, and nothing else, from a browser failure message.
 *
 * The token is a fixed enum drawn from a closed alphabet, so no address and no
 * credential can survive the match. The rest of the message, which quotes the
 * URL Chrome was working on, is discarded.
 */
function chromeNetErrorToken(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  return /\bnet::(ERR_[A-Z0-9_]+)/u.exec(message)?.[1]
}

function browserErrorOutcome(code: string): AcquisitionAttemptOutcome {
  switch (code) {
    case 'access_challenge':
      return 'challenge'
    case 'access_denied':
      return 'access-denied'
    case 'rate_limited':
      return 'rate-limited'
    case 'not_found':
      return 'not-found'
    case 'empty_content':
      return 'insufficient'
    case 'domain_denied':
      return 'policy-denied'
    case 'timeout':
      return 'timeout'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

function rotate<T>(values: readonly T[], by: number): readonly T[] {
  if (values.length === 0) return values
  const offset = ((by % values.length) + values.length) % values.length
  return [...values.slice(offset), ...values.slice(0, offset)]
}

/**
 * Write one run outside source control and return its path.
 *
 * The default lives under the OS temporary directory precisely so it cannot be
 * committed by accident. `PIPELINE_BROWSER_COUNTERMEASURE_OUTPUT_DIR` moves it
 * somewhere an operator can keep.
 */
export async function writeCountermeasureReport(
  report: CountermeasureRunReport,
): Promise<string> {
  const directory =
    process.env.PIPELINE_BROWSER_COUNTERMEASURE_OUTPUT_DIR?.trim() ||
    path.join(os.tmpdir(), 'pipeline-browser-countermeasures')
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, `${report.runId}.json`)
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return file
}

// ---------------------------------------------------------------------------
// The deterministic origin. Local, offline, and the only place the harness is
// allowed to claim a gate was passed.

export interface ProtectedContentOrigin {
  readonly url: string
  readonly protectedContentLiteral: string
  readonly passTarget: CountermeasureTarget
  readonly failTarget: CountermeasureTarget
  readonly webdriverTarget: CountermeasureTarget
  readonly requestCounts: ReadonlyMap<string, number>
  close(): Promise<void>
}

const CHALLENGE_BODY =
  'Checking your browser before accessing the site. This process is automatic and will finish shortly.'

export async function startProtectedContentOrigin(): Promise<ProtectedContentOrigin> {
  const literal = `PROTECTED-CONTENT-${randomUUID()}`
  const grant = `GRANT-${randomUUID()}`
  const requestCounts = new Map<string, number>()

  const server = http.createServer((request, response) => {
    const requested = new URL(request.url ?? '/', 'http://127.0.0.1')
    const key = `${origin()}${requested.pathname}`
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1)

    if (requested.pathname === '/gated/protected') {
      if (requested.searchParams.get('t') === grant) {
        return html(response, protectedPage(literal))
      }
      return html(response, challengePage())
    }
    if (requested.pathname === '/gated/pass') {
      return html(response, challengePage(`location.replace('/gated/protected?t=${grant}')`))
    }
    if (requested.pathname === '/gated/fail') {
      return html(response, challengePage("location.replace('/gated/protected?t=refused')"))
    }
    if (requested.pathname === '/gated/webdriver') {
      // The gate opens only for a browser that does not announce automation, so
      // the launch profile under comparison is the only thing that can open it.
      return html(
        response,
        challengePage(
          `location.replace('/gated/protected?t=' + (navigator.webdriver === false ? '${grant}' : 'refused'))`,
        ),
      )
    }
    response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<html><title>Missing</title><body>Page not found.</body></html>')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('The protected-content origin did not bind a port.')
  }
  const base = `http://127.0.0.1:${address.port}`
  function origin(): string {
    return base
  }

  const target = (pathname: string): CountermeasureTarget => ({
    host: '127.0.0.1',
    probeUrl: `${base}${pathname}`,
    protectedContentLiteral: literal,
  })

  return {
    url: base,
    protectedContentLiteral: literal,
    passTarget: target('/gated/pass'),
    failTarget: target('/gated/fail'),
    webdriverTarget: target('/gated/webdriver'),
    requestCounts,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))),
  }
}

// ---------------------------------------------------------------------------
// The official anti-bot test widget. Live-only, because it loads the vendor's
// script over the network; the deterministic origin above stays offline.

/**
 * Cloudflare's documented dummy sitekeys for automated suites.
 *
 * These are documentation values, not credentials: no account, secret, or
 * server-side verification call is involved, and both are documented to work on
 * localhost. The client callback alone gates the local protected literal, so
 * nothing leaves this machine except loading the widget script itself.
 *
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
const WIDGET_ALWAYS_PASSES_SITEKEY = '1x00000000000000000000AA'
const WIDGET_ALWAYS_BLOCKS_SITEKEY = '2x00000000000000000000AB'
const WIDGET_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js'

export interface OfficialWidgetOrigin {
  readonly url: string
  readonly protectedContentLiteral: string
  /** The dummy sitekey documented to always issue a token. */
  readonly passTarget: CountermeasureTarget
  /** The dummy sitekey documented to always refuse one. */
  readonly failTarget: CountermeasureTarget
  close(): Promise<void>
}

/**
 * A page that gates real protected content behind a real widget callback.
 *
 * This is the target class the deterministic origin cannot stand in for.
 * Loading a widget is not passing a gate, so the literal appears only after the
 * widget hands the page a token, and the failing sitekey must leave the page a
 * wall.
 */
export async function startOfficialWidgetOrigin(): Promise<OfficialWidgetOrigin> {
  const literal = `WIDGET-PROTECTED-${randomUUID()}`
  const server = http.createServer((request, response) => {
    const requested = new URL(request.url ?? '/', 'http://127.0.0.1')
    const sitekey = requested.pathname === '/widget/pass'
      ? WIDGET_ALWAYS_PASSES_SITEKEY
      : requested.pathname === '/widget/fail'
        ? WIDGET_ALWAYS_BLOCKS_SITEKEY
        : undefined
    if (!sitekey) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><title>Missing</title><body>Page not found.</body></html>')
      return
    }
    html(response, widgetPage(sitekey, literal))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('The official widget origin did not bind a port.')
  }
  const base = `http://127.0.0.1:${address.port}`
  const target = (pathname: string): CountermeasureTarget => ({
    host: '127.0.0.1',
    probeUrl: `${base}${pathname}`,
    protectedContentLiteral: literal,
  })
  return {
    url: base,
    protectedContentLiteral: literal,
    passTarget: target('/widget/pass'),
    failTarget: target('/widget/fail'),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))),
  }
}

function widgetPage(sitekey: string, literal: string): string {
  return `<!doctype html><html><head><title>Verification required</title>
<script src="${WIDGET_SCRIPT_URL}" async defer></script>
</head><body>
<main><p id="gate">${CHALLENGE_BODY}</p></main>
<div class="cf-turnstile" data-sitekey="${sitekey}"
     data-callback="onWidgetToken" data-error-callback="onWidgetFailure"
     data-timeout-callback="onWidgetFailure"></div>
<script>
window.__widgetState = 'pending'
function onWidgetToken(token) {
  if (!token) { window.__widgetState = 'empty-token'; return }
  window.__widgetState = 'passed'
  document.getElementById('gate').textContent = ${JSON.stringify(literal)}
}
function onWidgetFailure() { window.__widgetState = 'failed' }
</script>
</body></html>`
}

/**
 * What one launch profile observed at the official widget.
 *
 * `callback` is the widget's own client callback, not our reading of the page:
 * the distinction matters because loading the widget is not passing it, and
 * only a token that actually arrived may unlock the literal.
 */
export interface OfficialWidgetVerification {
  readonly launchProfile: BrowserLaunchProfile
  readonly callback: string
  readonly protectedContentUnlocked: boolean
  readonly durationMs: number
  readonly timedOut: boolean
}

/**
 * Drive one widget page to a decision under one launch profile.
 *
 * This deliberately does not go through `acquireEvidence`. That path snapshots
 * as soon as the page has any content at all and waits at most 1.5 seconds for
 * it, which is shorter than a real widget takes to call back — so an acquisition
 * read could never distinguish a passed gate from an unfinished one. The launch
 * arguments come from the manager itself, so the profile under test is the
 * profile production would launch.
 */
export async function verifyOfficialWidgetGate(input: {
  readonly target: CountermeasureTarget
  readonly launchProfile: BrowserLaunchProfile
  readonly timeoutMs: number
}): Promise<OfficialWidgetVerification> {
  const began = Date.now()
  const executablePath = resolveBrowserExecutablePath()
  if (!executablePath) {
    throw new Error('A local Chrome installation is required for the widget check.')
  }
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: launchArguments(input.launchProfile),
  })
  try {
    const page = await browser.newPage()
    await page.goto(input.target.probeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: input.timeoutMs,
    })
    let timedOut = false
    await page
      .waitForFunction(
        () => (window as unknown as { __widgetState?: string }).__widgetState !== 'pending',
        { timeout: input.timeoutMs },
      )
      .catch(() => {
        timedOut = true
      })
    const observed = await page.evaluate(() => ({
      callback: String(
        (window as unknown as { __widgetState?: unknown }).__widgetState,
      ),
      text: document.body.innerText,
    }))
    return {
      launchProfile: input.launchProfile,
      callback: observed.callback,
      protectedContentUnlocked: Boolean(
        input.target.protectedContentLiteral &&
        observed.text.includes(input.target.protectedContentLiteral),
      ),
      durationMs: Math.max(0, Date.now() - began),
      timedOut,
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
}

function html(response: http.ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

function challengePage(script = ''): string {
  return `<!doctype html><html><head><title>Just a moment...</title></head><body>
<main><p>${CHALLENGE_BODY}</p></main>
${script ? `<script>${script}</script>` : ''}
</body></html>`
}

function protectedPage(literal: string): string {
  return `<!doctype html><html><head><title>Verified quarterly report</title></head><body><main>
<h1>Verified quarterly report</h1>
<p>${literal}</p>
<p>${'This report is only served once the gate has been passed, and it carries enough independently readable prose to clear the acquisition quality threshold on its own. '.repeat(6)}</p>
<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Growth</td><td>12.5%</td></tr></table>
</main></body></html>`
}
