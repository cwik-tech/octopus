import {
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
} from 'react'

import { MarkdownViewer } from '@/components/markdown-viewer'
import { ExcelWorkbookPreview } from '@/components/run/pickers/excel-workbook-preview'
import { Button } from '@/components/ui/button'
import { ResizableRightSheetContent } from '@/components/ui/resizable-right-sheet'
import {
  Sheet,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  artifactUrl,
  fetchArtifact,
  fetchExcelWorkbookPreview,
} from '@/lib/clients/runtime-client'
import type { ArtifactPreviewTarget } from '@/components/run/stage-renderers/index'
import type { ExcelWorkbookPreview as ExcelWorkbookPreviewModel } from '@/lib/models/runtime-model'

type LoadState =
  | { status: 'idle' | 'loading'; preview?: undefined; message?: undefined }
  | { status: 'success'; preview: PreviewContent; message?: undefined }
  | { status: 'error'; preview?: undefined; message: string }

type PreviewContent =
  | { kind: 'text'; content: string }
  | { kind: 'workbook'; workbook: ExcelWorkbookPreviewModel }

function getArtifactName(path: string): string {
  return path.split('/').at(-1) ?? path
}

function isExcelArtifact(path: string): boolean {
  return /\.xlsx$/i.test(path)
}

async function fetchPreview(
  target: ArtifactPreviewTarget,
): Promise<PreviewContent> {
  if (isExcelArtifact(target.artifactPath)) {
    return {
      kind: 'workbook',
      workbook: await fetchExcelWorkbookPreview(
        target.runId,
        target.artifactPath,
      ),
    }
  }
  return {
    kind: 'text',
    content: await fetchArtifact(target.runId, target.artifactPath),
  }
}

export function ArtifactPreviewSheet({
  onOpenArtifact,
  onOpenChange,
  open,
  target,
}: {
  onOpenArtifact?: (target: ArtifactPreviewTarget) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  target: ArtifactPreviewTarget | null
}) {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' })
  const [copied, setCopied] = useState(false)

  const title = useMemo(
    () => (target ? getArtifactName(target.artifactPath) : 'Artifact'),
    [target],
  )
  const isExcel = isExcelArtifact(target?.artifactPath ?? '')
  const isBinary = /\.(?:docx|xlsx)$/i.test(target?.artifactPath ?? '')

  // Reset the load state as the sheet's target changes — done during render
  // (React's "adjust state on prop change" pattern) rather than in an effect,
  // so opening a new artifact never flashes the previous one's content.
  const targetKey = open && target
    ? JSON.stringify([target.runId, target.artifactPath])
    : null
  const [activeKey, setActiveKey] = useState<string | null>(null)
  if (targetKey !== activeKey) {
    setActiveKey(targetKey)
    setLoadState(targetKey ? { status: 'loading' } : { status: 'idle' })
    setCopied(false)
  }

  useEffect(() => {
    if (!open || !target) return undefined

    let cancelled = false
    void fetchPreview(target)
      .then((preview) => {
        if (!cancelled) setLoadState({ status: 'success', preview })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
    }
  }, [open, target])

  const handleRetry = () => {
    if (!target) return
    setLoadState({ status: 'loading' })
    void fetchPreview(target)
      .then((preview) => setLoadState({ status: 'success', preview }))
      .catch((error: unknown) => {
        setLoadState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const handleCopy = () => {
    if (
      loadState.status !== 'success' ||
      loadState.preview.kind !== 'text'
    ) {
      return
    }
    void navigator.clipboard
      .writeText(loadState.preview.content)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <ResizableRightSheetContent
        defaultWidth={680}
        minimumWidth={420}
        open={open}
        resizeLabel="Resize artifact sheet"
        headerContent={
          <SheetTitle className="flex min-w-0 items-center gap-2 text-base">
            {isExcel ? (
              <FileSpreadsheet className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
            ) : (
              <FileText className="size-4 shrink-0" />
            )}
            <span className="truncate" title={target?.artifactPath}>
              {title}
            </span>
          </SheetTitle>
        }
        headerActions={
          <>
            {!isBinary ? (
              <Button
                aria-label="Copy content"
                disabled={loadState.status !== 'success'}
                size="icon-sm"
                type="button"
                variant="ghost"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="size-4 text-emerald-600 dark:text-emerald-500" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            ) : null}
            {target ? (
              <Button
                aria-label={`Download ${title}`}
                size="icon-sm"
                type="button"
                variant="ghost"
                render={
                  <a
                    download={title}
                    href={artifactUrl(target.runId, target.artifactPath)}
                  />
                }
              >
                <Download className="size-4" />
              </Button>
            ) : null}
          </>
        }
      >

        <div className="min-h-0 flex-1 overflow-hidden">
          {loadState.status === 'loading' ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading artifact
            </div>
          ) : null}

          {loadState.status === 'error' ? (
            <div className="m-5 rounded-lg border border-destructive/25 bg-destructive/8 p-4">
              <div className="text-sm font-medium text-destructive">
                Failed to load artifact
              </div>
              <div className="mt-1 break-words text-xs text-muted-foreground">
                {loadState.message}
              </div>
              <Button
                className="mt-3 gap-1.5"
                size="sm"
                type="button"
                variant="outline"
                onClick={handleRetry}
              >
                <RefreshCw className="size-3.5" />
                Retry
              </Button>
            </div>
          ) : null}

          {loadState.status === 'success' ? (
            loadState.preview.kind === 'workbook' ? (
              <ExcelWorkbookPreview
                key={targetKey}
                workbook={loadState.preview.workbook}
              />
            ) : (
              <div className="h-full overflow-y-auto px-5 py-4">
                <MarkdownViewer
                  artifactRunId={target?.runId}
                  content={loadState.preview.content}
                  currentArtifactPath={target?.artifactPath}
                  onOpenArtifact={onOpenArtifact}
                />
              </div>
            )
          ) : null}
        </div>
      </ResizableRightSheetContent>
    </Sheet>
  )
}
