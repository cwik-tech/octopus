import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import type {
  BrowserActivityRecord,
  ResearchWebActivityRecord,
} from '../../domains/acquisition/research-activity-projection.js'
import { ResearchActivityProjectionService } from '../../services/research-activity-projection-service.js'
import { handleResearchActivityRoutes } from '../../server/routes/research-activity.js'
import { BrowserFaviconService } from '../../services/browser-favicon-service.js'

/**
 * One read model for a turn that used both research tools.
 *
 * The renderer must not have to know which tool produced a step, so the two
 * journals are merged behind one endpoint here rather than in the component.
 */

const browserActivity: BrowserActivityRecord = {
  activityId: 'browser-open',
  sessionId: 'session-1',
  runId: 'run-1',
  assignmentId: 'assignment-1',
  activityScopeId: 'lane-1',
  agentPath: 'agents/web-researcher',
  toolCallId: 'call-browser',
  action: 'open',
  state: 'completed',
  createdAt: '2026-08-28T10:00:02.000Z',
  updatedAt: '2026-08-28T10:00:03.000Z',
  url: 'https://interactive.example/page',
  title: 'Interactive page',
  attachment: {
    id: 'attachment-1',
    kind: 'screenshot',
    name: 'shot.png',
    relativePath: 'browser-downloads/shot.png',
    mimeType: 'image/png',
    sizeBytes: 64,
  },
}

const researchSearch: ResearchWebActivityRecord = {
  activityId: 'research-search',
  sessionId: 'session-1',
  runId: 'run-1',
  assignmentId: 'assignment-1',
  activityScopeId: 'lane-1',
  agentPath: 'agents/web-researcher',
  toolCallId: 'call-search',
  providerCallOrdinal: 0,
  action: 'search',
  state: 'completed',
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-28T10:00:01.000Z',
  resultCount: 3,
  searchProviders: ['brave'],
}

const researchAcquire: ResearchWebActivityRecord = {
  activityId: 'research-acquire',
  sessionId: 'session-1',
  runId: 'run-1',
  assignmentId: 'assignment-1',
  activityScopeId: 'lane-1',
  agentPath: 'agents/web-researcher',
  toolCallId: 'call-acquire',
  providerCallOrdinal: 1,
  action: 'acquire',
  state: 'completed',
  createdAt: '2026-08-28T10:00:04.000Z',
  updatedAt: '2026-08-28T10:00:05.000Z',
  requestedUrl: 'https://acquired.example/report',
  canonicalUrl: 'https://acquired.example/report',
  title: 'Acquired report',
}

const failedAcquire: ResearchWebActivityRecord = {
  activityId: 'research-failed',
  sessionId: 'session-1',
  runId: 'run-1',
  assignmentId: 'assignment-1',
  activityScopeId: 'lane-1',
  agentPath: 'agents/web-researcher',
  toolCallId: 'call-failed',
  providerCallOrdinal: 2,
  action: 'acquire',
  state: 'failed',
  createdAt: '2026-08-28T10:00:06.000Z',
  updatedAt: '2026-08-28T10:00:07.000Z',
  requestedUrl: 'https://blocked.example/report',
  error: { code: 'access_denied', message: 'Access was denied.' },
}

test('the endpoint returns both tools as one ordered read model', async () => {
  const base = await startRouteServer(projection({
    browser: [browserActivity],
    researchWeb: [researchSearch, researchAcquire, failedAcquire],
  }))
  try {
    const response = await fetch(`${base.url}/sessions/session-1/research-activity`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json() as {
      activities: readonly Record<string, unknown>[]
    }
    assert.deepEqual(
      body.activities.map((activity) => activity.activityId),
      ['research-search', 'browser-open', 'research-acquire', 'research-failed'],
    )
    assert.deepEqual(
      body.activities.map((activity) => activity.source),
      ['research-web', 'browser', 'research-web', 'research-web'],
    )
    assert.deepEqual(
      body.activities.map((activity) => activity.kind),
      ['search', 'page', 'page', 'page'],
    )
    const [search, browser, acquired] = body.activities
    assert.deepEqual(search?.searchProviders, ['brave'])
    assert.equal(search?.resultCount, 3)
    assert.equal(search?.url, undefined)
    assert.equal(browser?.url, 'https://interactive.example/page')
    assert.deepEqual(browser?.attachment, browserActivity.attachment)
    assert.equal(acquired?.url, 'https://acquired.example/report')
    assert.equal(acquired?.title, 'Acquired report')
  } finally {
    await base.close()
  }
})

test('the endpoint answers empty when neither research tool is available', async () => {
  const base = await startRouteServer(new ResearchActivityProjectionService({}))
  try {
    const response = await fetch(`${base.url}/sessions/session-1/research-activity`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { activities: [] })
  } finally {
    await base.close()
  }
})

test('the endpoint keeps the narrow HTTP behavior of the activity routes', async () => {
  const base = await startRouteServer(projection({
    browser: [],
    researchWeb: [researchSearch],
  }))
  try {
    const wrongMethod = await fetch(
      `${base.url}/sessions/session-1/research-activity`,
      { method: 'POST' },
    )
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'GET')

    const malformed = await fetch(
      `${base.url}/sessions/%E0%A4%A/research-activity`,
    )
    assert.equal(malformed.status, 400)

    const unmatched = await fetch(`${base.url}/sessions/session-1/other`)
    assert.equal(unmatched.status, 404)
  } finally {
    await base.close()
  }
})

test('a successful research-web page authorizes its own site icon and a failed one does not', async () => {
  const icon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
  const iconServer = http.createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(icon)
      return
    }
    response.writeHead(404)
    response.end()
  })
  const iconOrigin = await listenOnLoopback(iconServer)
  const acquired: ResearchWebActivityRecord = {
    ...researchAcquire,
    requestedUrl: `${iconOrigin}/report`,
    canonicalUrl: `${iconOrigin}/report`,
  }
  const service = projection({
    browser: [],
    researchWeb: [acquired, failedAcquire],
  })
  const base = await startRouteServer(
    service,
    new BrowserFaviconService({
      listSessionUrls: (sessionId) => service.listVisitedUrls(sessionId),
      allowHttpLocalhost: true,
    }),
  )

  try {
    const served = await fetch(
      `${base.url}/sessions/session-1/research-activity/favicon?origin=${encodeURIComponent(iconOrigin)}`,
    )
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/png')

    const failedOrigin = await fetch(
      `${base.url}/sessions/session-1/research-activity/favicon?origin=${encodeURIComponent('https://blocked.example')}`,
    )
    assert.equal(failedOrigin.status, 404)

    const unrecorded = await fetch(
      `${base.url}/sessions/session-1/research-activity/favicon?origin=${encodeURIComponent('https://never-visited.example')}`,
    )
    assert.equal(unrecorded.status, 404)

    const otherSession = await fetch(
      `${base.url}/sessions/session-2/research-activity/favicon?origin=${encodeURIComponent(iconOrigin)}`,
    )
    assert.equal(otherSession.status, 404)
  } finally {
    await base.close()
    await new Promise<void>((resolve) => iconServer.close(() => resolve()))
  }
})

function projection(sources: {
  readonly browser: readonly BrowserActivityRecord[]
  readonly researchWeb: readonly ResearchWebActivityRecord[]
}): ResearchActivityProjectionService {
  return new ResearchActivityProjectionService({
    browser: {
      listSession: async (sessionId) =>
        sources.browser.filter((entry) => entry.sessionId === sessionId),
    },
    researchWeb: {
      listSession: async (sessionId) =>
        sources.researchWeb.filter((entry) => entry.sessionId === sessionId),
    },
  })
}

async function startRouteServer(
  projections: ResearchActivityProjectionService,
  favicons?: BrowserFaviconService,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handleResearchActivityRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      activities: projections,
      ...(favicons ? { favicons } : {}),
    }).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.statusCode = 404
        res.end()
      }
    })
  })
  const url = await listenOnLoopback(server)
  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function listenOnLoopback(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}
