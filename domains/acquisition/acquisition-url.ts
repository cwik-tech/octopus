const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
])

export function canonicalizeSourceUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password) {
    throw new Error('Source URLs must not contain credentials.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Source URL must use HTTP or HTTPS.')
  }
  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = ''
  }
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase()
    if (lower.startsWith('utm_') || TRACKING_PARAMETERS.has(lower)) {
      url.searchParams.delete(key)
    }
  }
  url.searchParams.sort()
  if (url.pathname !== '/') {
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/'
  }
  return url.toString()
}

export function normalizeSearchDomain(value: string): string | null {
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed.length > 253 ||
    trimmed.includes('://') ||
    /[\s?#@\\]/u.test(trimmed)
  ) {
    return null
  }
  const separator = trimmed.indexOf('/')
  const hostPattern = (
    separator >= 0 ? trimmed.slice(0, separator) : trimmed
  ).toLowerCase().replace(/^\.+|\.+$/gu, '')
  const pathPrefix = separator >= 0 ? trimmed.slice(separator + 1) : ''
  const wildcard = hostPattern.startsWith('*.')
  const host = wildcard ? hostPattern.slice(2) : hostPattern
  if (
    !host ||
    !/^[a-z0-9.-]+$/u.test(host) ||
    host.split('.').some((part) =>
      !part ||
      part.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part)
    ) ||
    pathPrefix.split('/').some((part) => part === '.' || part === '..')
  ) {
    return null
  }
  return `${wildcard ? '*.' : ''}${host}${pathPrefix ? `/${pathPrefix}` : ''}`
}
