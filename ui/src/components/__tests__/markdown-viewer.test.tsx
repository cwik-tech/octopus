import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarkdownViewer, type MarkdownArtifactTarget } from '@/components/markdown-viewer'

afterEach(() => vi.unstubAllGlobals())

// jsdom cannot fetch the renderer's relative /api URL or register browser blob
// URLs. The image component separately exercises a real loopback HTTP server.
function installImageBoundary() {
  const requests: string[] = []
  let next = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(url); return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'content-type': 'application/octet-stream' } }) }))
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => `blob:artifact-image-${++next}`, revokeObjectURL: vi.fn() }))
  return requests
}

describe('MarkdownViewer', () => {
  it('renders body text when content has no frontmatter', async () => {
    render(<MarkdownViewer content={'# Hello World\n\nSome body text.'} />)

    expect(await screen.findByText('Hello World')).toBeInTheDocument()
    expect(await screen.findByText('Some body text.')).toBeInTheDocument()
  })

  it('renders body text when content is plain text without frontmatter', async () => {
    render(<MarkdownViewer content="Just plain text with no markers." />)

    expect(
      await screen.findByText('Just plain text with no markers.'),
    ).toBeInTheDocument()
  })

  it('renders headings as headings rather than plain paragraphs', async () => {
    render(
      <MarkdownViewer content={'# Title\n\n## Section\n\nParagraph text.'} />,
    )

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Title' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Section' }),
    ).toBeInTheDocument()
  })

  it('hides frontmatter metadata instead of rendering it above the body', async () => {
    const content = `---
artifact_type: result
title: Weekly Report
author: Alice
---

# Report

Here is the content.`

    render(<MarkdownViewer content={content} />)

    expect(await screen.findByText('Here is the content.')).toBeInTheDocument()
    expect(screen.queryByText('artifact_type')).not.toBeInTheDocument()
    expect(screen.queryByText('title')).not.toBeInTheDocument()
    expect(screen.queryByText('Weekly Report')).not.toBeInTheDocument()
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
  })

  it('renders fenced code blocks when present in content', async () => {
    render(
      <MarkdownViewer
        content={`---\ntitle: Test\n---

\`\`\`javascript
const x = 1;
\`\``}
      />,
    )

    const code = await screen.findByText((_, element) =>
      element?.tagName.toLowerCase() === 'code' &&
      Boolean(element.textContent?.includes('const x = 1;')),
    )
    expect(code.closest('pre')).toBeInTheDocument()
  })

  it('renders GFM features (tables, strikethrough) when present', async () => {
    render(
      <MarkdownViewer
        content={`---\ntitle: Table Test\n---

| A | B |
|---|---|
| 1 | 2 |

~~deleted~~ text`
      }
      />,
    )

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(await screen.findByText('A')).toBeInTheDocument()
    expect(await screen.findByText('B')).toBeInTheDocument()
    expect(await screen.findByText('1')).toBeInTheDocument()
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(await screen.findByText('deleted')).toBeInTheDocument()
  })

  it('handles empty string content gracefully', async () => {
    const { container } = render(<MarkdownViewer content="" />)

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
    expect(container).toBeInTheDocument()
  })

  it('handles single-line frontmatter without trailing newline', async () => {
    const content = `---\ntitle: Quick\n---\nBody here`

    render(<MarkdownViewer content={content} />)

    expect(await screen.findByText('Body here')).toBeInTheDocument()
    expect(screen.queryByText('title')).not.toBeInTheDocument()
  })

  it('opens markdown artifacts from body links', async () => {
    const onOpenArtifact = vi.fn()

    render(
      <MarkdownViewer
        artifactRunId="run-1"
        content="[Open report](output/report.md)"
        onOpenArtifact={onOpenArtifact}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /open report/i }))

    expect(onOpenArtifact).toHaveBeenCalledWith({
      artifactPath: 'output/report.md',
      runId: 'run-1',
    })
  })

  it('opens external links outside the app with opener isolation', async () => {
    render(
      <MarkdownViewer content="[Open documentation](https://example.com/docs)" />,
    )

    const link = await screen.findByRole('link', { name: 'Open documentation' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('keeps in-document links in the current window', async () => {
    render(<MarkdownViewer content="[Jump to details](#details)" />)

    const link = await screen.findByRole('link', { name: 'Jump to details' })
    expect(link).not.toHaveAttribute('target')
    expect(link).not.toHaveAttribute('rel')
  })

  it('resolves body markdown links relative to the current artifact path', async () => {
    const onOpenArtifact = vi.fn()

    render(
      <MarkdownViewer
        artifactRunId="run-1"
        content="[Open report](report.md)"
        currentArtifactPath="output/final.md"
        onOpenArtifact={onOpenArtifact}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /open report/i }))

    expect(onOpenArtifact).toHaveBeenCalledWith({
      artifactPath: 'output/report.md',
      runId: 'run-1',
    })
  })

  it('resolves parent-relative markdown links against the current artifact path', async () => {
    const onOpenArtifact = vi.fn()

    render(
      <MarkdownViewer
        artifactRunId="run-1"
        content="[Open report](../shared/report.md)"
        currentArtifactPath="output/runs/final.md"
        onOpenArtifact={onOpenArtifact}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /open report/i }))

    expect(onOpenArtifact).toHaveBeenCalledWith({
      artifactPath: 'output/shared/report.md',
      runId: 'run-1',
    })
  })

  it('resolves identical bodies against each artifact\'s own path', async () => {
    const onOpenArtifact = vi.fn<(target: MarkdownArtifactTarget) => void>()
    const body = '[Open report](report.md)'

    const { rerender } = render(
      <MarkdownViewer
        artifactRunId="run-1"
        content={body}
        currentArtifactPath="first/index.md"
        onOpenArtifact={onOpenArtifact}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /open report/i }))

    rerender(
      <MarkdownViewer
        artifactRunId="run-1"
        content={body}
        currentArtifactPath="second/index.md"
        onOpenArtifact={onOpenArtifact}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /open report/i }))

    expect(onOpenArtifact.mock.calls.map(([target]) => target.artifactPath)).toEqual([
      'first/report.md',
      'second/report.md',
    ])
  })
})

describe('Markdown artifact screenshots', () => {
  it('resolves nested relative images through the run artifact endpoint', async () => {
    const requests = installImageBoundary()
    render(<MarkdownViewer artifactRunId="run-md" currentArtifactPath="child/output/manuals/video/run/manual.md"
      content={'# Takeaways\n\n![Training slide](frames/training%20data.png)'} />)
    const image = await screen.findByAltText('Training slide')
    expect(image.getAttribute('src')).toBe('blob:artifact-image-1')
    expect(requests[0]).toContain('/runs/run-md/assignments/child/output/manuals/video/run/frames/training%20data.png')
  })
})

it('resolves identical Markdown in a different run against that run', async () => {
  const requests = installImageBoundary()
  const content = '![Frame](frames/frame.png)'
  const { rerender } = render(<MarkdownViewer artifactRunId="first" currentArtifactPath="child/manual.md" content={content} />)
  expect((await screen.findByAltText('Frame')).getAttribute('src')).toBe('blob:artifact-image-1')
  expect(requests[0]).toContain('/runs/first/')
  rerender(<MarkdownViewer artifactRunId="second" currentArtifactPath="child/manual.md" content={content} />)
  await waitFor(() => expect(screen.getByAltText('Frame').getAttribute('src')).toBe('blob:artifact-image-2'))
  expect(requests[1]).toContain('/runs/second/')
})
