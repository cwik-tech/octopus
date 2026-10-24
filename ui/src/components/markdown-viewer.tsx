import { ArtifactMarkdownImage } from '@/components/artifact-markdown-image'
import { defaultRemarkPlugins } from 'streamdown'

import { MessageResponse } from '@/components/ai-elements/message'
import { parseMarkdownArtifact } from '@/lib/models/runtime-model'
import { artifactUrl } from '@/lib/clients/runtime-client'
import { Button } from '@/components/ui/button'

export interface MarkdownArtifactTarget {
  artifactPath: string
  runId: string
}

export interface MarkdownViewerProps {
  artifactRunId?: string | undefined
  content: string
  currentArtifactPath?: string | undefined
  onOpenArtifact?: ((target: MarkdownArtifactTarget) => void) | undefined
}

/** Matches Streamdown's own anchor styling so artifact links read like chat links. */
const linkClassName = 'font-medium text-primary-text underline'

function isMarkdownArtifactRef(value: string): boolean {
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return false
  }

  return /\.md(?:[#?].*)?$/i.test(trimmed)
}

function isExternalMarkdownLink(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim())
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function joinArtifactPath(baseDir: string, targetPath: string): string {
  const segments: string[] = []

  for (const segment of `${baseDir}/${targetPath}`.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  return segments.join('/')
}

function normalizeArtifactPath(value: string, currentArtifactPath?: string): string {
  const cleaned = value.trim().replace(/[#?].*$/, '').replace(/^\/+/, '')
  if (!currentArtifactPath) return cleaned.replace(/^\.\//, '')

  const shouldResolveRelative =
    cleaned.startsWith('./') ||
    cleaned.startsWith('../') ||
    !cleaned.includes('/')
  if (!shouldResolveRelative) return cleaned

  return joinArtifactPath(dirname(currentArtifactPath), cleaned)
}

interface MarkdownLinkNode {
  children?: MarkdownLinkNode[]
  type: string
  url?: string
}

/**
 * Streamdown sanitizes every href before a component can see it, and that pass
 * resolves relative links against the page origin — which would throw away the
 * directory context this viewer needs to find a sibling artifact. So each
 * artifact reference is parked in a single percent-encoded path segment that
 * URL normalization leaves untouched, and unpacked again at render time.
 *
 * The plugin deliberately takes no arguments: Streamdown caches its Markdown
 * processor by plugin function name, so a per-artifact plugin would be served
 * another artifact's cached copy.
 */
function remarkPackArtifactLinks() {
  return (tree: MarkdownLinkNode) => {
    const pack = (node: MarkdownLinkNode) => {
      const isLink = node.type === 'link' || node.type === 'definition'
      if ((isLink && node.url && isMarkdownArtifactRef(node.url)) || (node.type === 'image' && node.url && isRelativeImage(node.url))) {
        node.url = `/${encodeURIComponent(node.url)}`
      }
      for (const child of node.children ?? []) pack(child)
    }

    pack(tree)
  }
}

/** Unpacks a reference written by {@link remarkPackArtifactLinks}. */
function unpackArtifactRef(href: string): string | null {
  if (!href.startsWith('/') || href.includes('/', 1)) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(href.slice(1))
  } catch {
    return null
  }

  return isMarkdownArtifactRef(decoded) ? decoded : null
}

const markdownPlugins = [
  ...Object.values(defaultRemarkPlugins),
  remarkPackArtifactLinks,
]

export function MarkdownViewer({
  artifactRunId,
  content,
  currentArtifactPath,
  onOpenArtifact,
}: MarkdownViewerProps) {
  const parsed = parseMarkdownArtifact(content)
  const canOpenArtifacts = Boolean(artifactRunId && onOpenArtifact)

  const openArtifact = (artifactPath: string) => {
    if (!artifactRunId || !onOpenArtifact) return
    onOpenArtifact({ artifactPath, runId: artifactRunId })
  }

  return (
    // Keyed by artifact path because MessageResponse memoizes on its children
    // alone: two artifacts with identical bodies must still resolve their
    // relative links against their own path.
    <MessageResponse
      key={`${artifactRunId ?? ''}:${currentArtifactPath ?? ''}`}
      mode="static"
      parseIncompleteMarkdown={false}
      remarkPlugins={markdownPlugins}
      components={{
        img: ({ src, alt, title }) => {
          const reference = typeof src === 'string' ? unpackImageRef(src) : null
          const resolved = reference && currentArtifactPath && artifactRunId
            ? artifactImagePath(currentArtifactPath, reference) : null
          if (resolved && artifactRunId) return <ArtifactMarkdownImage url={artifactUrl(artifactRunId, resolved)} alt={alt ?? ''} title={title} />
          return <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} title={title} />
        },
        // Markdown anchors only ever carry href and title; everything else in
        // the renderer's props is hast bookkeeping that must not reach the DOM.
        a: ({ href, children, title }) => {
          const artifactRef = href && canOpenArtifacts ? unpackArtifactRef(href) : null
          const artifactPath = artifactRef
            ? normalizeArtifactPath(artifactRef, currentArtifactPath)
            : null

          if (!artifactPath) {
            const external = href ? isExternalMarkdownLink(href) : false
            return (
              <a
                className={linkClassName}
                href={href}
                rel={external ? 'noopener noreferrer' : undefined}
                target={external ? '_blank' : undefined}
                title={title}
              >
                {children}
              </a>
            )
          }

          return (
            <Button
              className={`h-auto p-0 ${linkClassName} hover:text-primary-text/80`}
              title={title}
              variant="link"
              onClick={() => openArtifact(artifactPath)}
            >
              {children}
            </Button>
          )
        },
      }}
    >
      {parsed.body}
    </MessageResponse>
  )
}

function isRelativeImage(value: string): boolean {
  return !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value) && value.length > 0
}

function unpackImageRef(src: string): string | null {
  if (!src.startsWith('/') || src.includes('/', 1)) return null
  try {
    const decoded = decodeURIComponent(src.slice(1))
    return isRelativeImage(decoded) ? decoded : null
  } catch { return null }
}

function artifactImagePath(current: string, reference: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(reference.replace(/[?#].*$/, '')) } catch { return null }
  if (!isRelativeImage(decoded) || decoded.includes('\\') || decoded.includes('\0')) return null
  const segments = dirname(current).split('/').filter(Boolean)
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { if (!segments.length) return null; segments.pop() }
    else segments.push(segment)
  }
  return segments.join('/')
}
