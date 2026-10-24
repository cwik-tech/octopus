import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import { BrowserNetworkPolicy } from '../../domains/browser/browser-network-policy.js'
import {
  browserUrlAllowed,
  classifyBrowserAction,
  parseBrowserDomains,
  readBrowserAgentPolicy,
  resolveBrowserCapabilityEffect,
} from '../../domains/browser/browser-policy.js'

test('browser domain policy accepts only normalized exact and wildcard hosts', () => {
  assert.deepEqual(
    parseBrowserDomains('Example.com, *.Research.EXAMPLE.com, https://bad.example, example.com/path, example.com'),
    ['example.com', '*.research.example.com'],
  )
  assert.deepEqual(
    parseBrowserDomains(['localhost', '127.0.0.1', '', '*.', 'bad..example', '-bad.example']),
    ['localhost', '127.0.0.1'],
  )
})

test('browser URL policy defaults to public HTTPS and optionally restricts exact and wildcard domains', () => {
  const restricted = { restrictDomains: true }
  assert.equal(browserUrlAllowed('https://example.com/report', ['example.com'], restricted), true)
  assert.equal(browserUrlAllowed('https://sub.example.com/report', ['example.com'], restricted), false)
  assert.equal(browserUrlAllowed('https://sub.example.com/report', ['*.example.com'], restricted), true)
  assert.equal(browserUrlAllowed('https://example.com/report', ['*.example.com'], restricted), false)
  assert.equal(browserUrlAllowed('https://example.com/report', [], { restrictDomains: false }), true)
  assert.equal(browserUrlAllowed('https://sub.example.com/report', [], { restrictDomains: false }), true)
  assert.equal(browserUrlAllowed('https://127.0.0.1/report', [], { restrictDomains: false }), false)
  assert.equal(browserUrlAllowed('https://service.internal/report', [], { restrictDomains: false }), false)
  assert.equal(browserUrlAllowed('http://example.com/report', [], { restrictDomains: false }), false)
  assert.equal(browserUrlAllowed('https://user:secret@example.com/report', [], { restrictDomains: false }), false)
  assert.equal(browserUrlAllowed('http://127.0.0.1:8080/report', ['127.0.0.1'], {
    allowHttpLocalhost: true,
    restrictDomains: true,
  }), true)
})

test('browser actions classify links as read-only and submissions as approval-gated', () => {
  assert.equal(classifyBrowserAction('observe'), 'read-only')
  assert.equal(classifyBrowserAction('click', { tag: 'a', href: 'https://example.com' }), 'read-only')
  assert.equal(classifyBrowserAction('click', { tag: 'button', name: 'Save report' }), 'mutating')
  assert.equal(classifyBrowserAction('click', { tag: 'button', name: 'Delete project' }), 'destructive')
  assert.equal(classifyBrowserAction('download'), 'mutating')
  assert.equal(classifyBrowserAction('press', undefined, 'Enter'), 'mutating')
})

test('browser action effects preserve risk while remaining serial', () => {
  const cases = [
    {
      risk: classifyBrowserAction('click', {
        tag: 'a',
        href: 'https://example.com',
      }),
      expected: serialCapabilityEffect('read-only'),
    },
    {
      risk: classifyBrowserAction('click', {
        tag: 'button',
        name: 'Save report',
      }),
      expected: serialCapabilityEffect('mutating'),
    },
    {
      risk: classifyBrowserAction('click', {
        tag: 'button',
        name: 'Delete project',
      }),
      expected: serialCapabilityEffect('destructive'),
    },
  ] as const

  for (const { risk, expected } of cases) {
    assert.strictEqual(resolveBrowserCapabilityEffect(risk), expected)
  }
})

test('agent browser policy is read from package frontmatter with a secure disabled fallback', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-policy-'))
  const agentDir = path.join(repoRoot, 'agents', 'researcher')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'researcher.md'), [
    '---',
    'name: researcher',
    'tools: browser, read',
    'browser_restrict_domains: true',
    'browser_domains: example.com, *.research.example.com',
    '---',
    '',
    '# Researcher',
  ].join('\n'))

  try {
    assert.deepEqual(readBrowserAgentPolicy(repoRoot, 'agents/researcher'), {
      enabled: true,
      restrictDomains: true,
      domains: ['example.com', '*.research.example.com'],
    })
    assert.deepEqual(readBrowserAgentPolicy(repoRoot, 'agents/missing'), {
      enabled: false,
      restrictDomains: false,
      domains: [],
    })
    assert.deepEqual(readBrowserAgentPolicy(repoRoot, '../researcher'), {
      enabled: false,
      restrictDomains: false,
      domains: [],
    })
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('shipped Web Researcher retains managed browser access', () => {
  assert.deepEqual(
    readBrowserAgentPolicy(process.cwd(), 'agents/web-researcher'),
    {
      enabled: true,
      restrictDomains: false,
      domains: [],
    },
  )
})


/**
 * IPv6 literals whose address family the unrestricted host policy must decide.
 *
 * The authorities are written in the dotted spelling an author would type; URL
 * parsing normalizes them to hextets before any policy code sees them, which is
 * exactly why a check written against the dotted form never fires in production.
 */
const EMBEDDED_IPV6_HOSTS: ReadonlyArray<{
  readonly authority: string
  readonly allowed: boolean
  readonly why: string
}> = [
  { authority: '[::ffff:127.0.0.1]', allowed: false, why: 'IPv4-mapped loopback' },
  { authority: '[::ffff:192.168.1.1]', allowed: false, why: 'IPv4-mapped RFC1918' },
  { authority: '[64:ff9b::127.0.0.1]', allowed: false, why: 'NAT64-embedded loopback' },
  { authority: '[::127.0.0.1]', allowed: false, why: 'IPv4-compatible loopback' },
  { authority: '[fd00::1]', allowed: false, why: 'unique local, compressed' },
  { authority: '[fd00:0:0:0:0:0:0:1]', allowed: false, why: 'unique local, uncompressed' },
  { authority: '[::ffff:93.184.216.34]', allowed: true, why: 'IPv4-mapped public control' },
  { authority: '[::93.184.216.34]', allowed: true, why: 'IPv4-compatible public control' },
  { authority: '[64:ff9b::93.184.216.34]', allowed: true, why: 'NAT64-embedded public control' },
  { authority: '[2606:4700::1111]', allowed: true, why: 'native public control' },
]

test('IPv6 web hosts are classified by their embedded IPv4 at both browser boundaries', async () => {
  const lookups: string[] = []
  const network = new BrowserNetworkPolicy({
    lookup: (async (host: string) => {
      lookups.push(host)
      return [{ address: '93.184.216.34', family: 4 }]
    }) as never,
  })
  const unrestricted = { enabled: true, restrictDomains: false, domains: [] }

  for (const host of EMBEDDED_IPV6_HOSTS) {
    const url = `https://${host.authority}/report`
    assert.equal(
      browserUrlAllowed(url, [], { restrictDomains: false }),
      host.allowed,
      `browserUrlAllowed ${host.authority} (${host.why})`,
    )
    assert.equal(
      await network.allows(url, unrestricted),
      host.allowed,
      `BrowserNetworkPolicy.allows ${host.authority} (${host.why})`,
    )
  }

  // An IP literal is decided from the literal itself. A resolver call here would
  // mean the address never reached the host policy at all, so the verdicts above
  // would be proving something other than the classification.
  assert.deepEqual(lookups, [])
})

test('a malformed IPv6 literal is refused before address classification', () => {
  // Regression, not Red: `isIP` rejects this before `isPublicWebHost` classifies
  // anything, and URL parsing rejects it before that. Recorded so a future
  // expander cannot start accepting what it cannot parse.
  assert.equal(browserUrlAllowed('https://[::gg]/report', [], { restrictDomains: false }), false)
})
