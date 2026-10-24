import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packages = [
  { name: 'root', cwd: repoRoot },
  { name: 'ui', cwd: path.join(repoRoot, 'ui') },
  { name: 'file-parser', cwd: path.join(repoRoot, 'file-parser') },
]

const acceptedAdvisories = new Map()

let failed = false

for (const packageInfo of packages) {
  const result = spawnSync('npm', ['audit', '--json'], {
    cwd: packageInfo.cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })

  if (result.error || result.signal || ![0, 1].includes(result.status ?? -1)) {
    console.error(
      `[security] ${packageInfo.name}: npm audit failed to execute` +
      `${result.signal ? ` (signal ${result.signal})` : ''}.`,
    )
    if (result.error) console.error(result.error.message)
    if (result.stderr) console.error(result.stderr.trim())
    failed = true
    continue
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    console.error(`[security] ${packageInfo.name}: npm audit did not return valid JSON.`)
    if (result.stderr) console.error(result.stderr.trim())
    failed = true
    continue
  }

  if (
    report?.error ||
    !report?.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    !report?.metadata?.vulnerabilities ||
    !['high', 'critical'].every((severity) =>
      Number.isInteger(report.metadata.vulnerabilities[severity]) &&
      report.metadata.vulnerabilities[severity] >= 0,
    )
  ) {
    const detail = report?.error?.summary || report?.error?.message
    console.error(
      `[security] ${packageInfo.name}: npm audit returned an incomplete report` +
      `${detail ? `: ${detail}` : '.'}`,
    )
    if (result.stderr) console.error(result.stderr.trim())
    failed = true
    continue
  }

  const accepted = acceptedAdvisories.get(packageInfo.name) ?? new Set()
  const advisories = new Map()
  const vulnerabilityEntries = Object.entries(report.vulnerabilities ?? {})
  for (const [, vulnerability] of vulnerabilityEntries) {
    if (!vulnerability || typeof vulnerability !== 'object') continue
    for (const via of Array.isArray(vulnerability.via) ? vulnerability.via : []) {
      if (typeof via !== 'object' || via === null) continue
      if (via.severity !== 'high' && via.severity !== 'critical') continue
      if (
        !Number.isInteger(via.source) ||
        via.source <= 0 ||
        typeof via.name !== 'string' ||
        typeof via.title !== 'string'
      ) continue
      advisories.set(via.source, via)
    }
  }

  const resolvesToStructuredAdvisory = (packageName, visited = new Set()) => {
    if (visited.has(packageName)) return false
    visited.add(packageName)
    const vulnerability = report.vulnerabilities[packageName]
    if (!vulnerability || !Array.isArray(vulnerability.via)) return false
    return vulnerability.via.some((via) => {
      if (typeof via === 'string') {
        return resolvesToStructuredAdvisory(via, new Set(visited))
      }
      return Boolean(
        via &&
        typeof via === 'object' &&
        (via.severity === 'high' || via.severity === 'critical') &&
        Number.isInteger(via.source) &&
        via.source > 0 &&
        typeof via.name === 'string' &&
        typeof via.title === 'string',
      )
    })
  }
  const unexplainedVulnerabilities = vulnerabilityEntries.filter(
    ([packageName, vulnerability]) =>
      vulnerability &&
      typeof vulnerability === 'object' &&
      (vulnerability.severity === 'high' || vulnerability.severity === 'critical') &&
      !resolvesToStructuredAdvisory(packageName),
  )
  for (const [packageName, vulnerability] of unexplainedVulnerabilities) {
    console.error(
      `[security] ${packageInfo.name}: ${vulnerability.severity} vulnerability ` +
      `'${packageName}' cannot be traced to a complete structured advisory object.`,
    )
  }
  if (unexplainedVulnerabilities.length > 0) failed = true
  for (const severity of ['high', 'critical']) {
    const detailedCount = vulnerabilityEntries.filter(
      ([, vulnerability]) =>
        vulnerability &&
        typeof vulnerability === 'object' &&
        vulnerability.severity === severity,
    ).length
    if (detailedCount !== report.metadata.vulnerabilities[severity]) {
      console.error(
        `[security] ${packageInfo.name}: metadata reports ` +
        `${report.metadata.vulnerabilities[severity]} ${severity} vulnerability(s), ` +
        `but the detailed report contains ${detailedCount}.`,
      )
      failed = true
    }
  }

  const unaccepted = [...advisories.values()].filter(
    (advisory) => !accepted.has(advisory.source),
  )
  const staleAcceptances = [...accepted].filter((source) => !advisories.has(source))

  for (const advisory of advisories.values()) {
    const disposition = accepted.has(advisory.source) ? 'accepted' : 'blocked'
    console.log(
      `[security] ${packageInfo.name}: ${disposition} ${advisory.severity} ` +
      `${advisory.name} ${advisory.source} - ${advisory.title}`,
    )
  }
  if (
    advisories.size === 0 &&
    report.metadata.vulnerabilities.high === 0 &&
    report.metadata.vulnerabilities.critical === 0
  ) {
    console.log(`[security] ${packageInfo.name}: no high or critical advisories`)
  }
  if (staleAcceptances.length > 0) {
    console.error(
      `[security] ${packageInfo.name}: remove stale accepted advisory IDs: ` +
      staleAcceptances.join(', '),
    )
    failed = true
  }
  if (unaccepted.length > 0) failed = true
}

if (failed) process.exit(1)
