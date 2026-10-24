import { visibleDeliveryArtifacts } from '@/lib/chat/visible-delivery-artifacts'
import { Download, FileText } from "lucide-react";
import { useState } from "react";
import { useCanvas } from '@/components/canvas/canvas-context'

import { ArtifactPreviewSheet } from "@/components/run/pickers/artifact-preview-sheet";
import type { ArtifactPreviewTarget } from "@/components/run/stage-renderers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { artifactUrl } from "@/lib/clients/runtime-client";
import type { ChatDeliveryArtifact, ChatMessageDelivery } from "@/lib/models/session-model";

/**
 * Persisted final-delivery payload attached to a chat message: one card per
 * delivered artifact, primary first. Cards stay compact — content opens in
 * Canvas when available, otherwise the legacy preview sheet or download.
 */
export function DeliveryMessageCard({
  delivery,
}: {
  delivery: ChatMessageDelivery;
}) {
  const [previewTarget, setPreviewTarget] = useState<ArtifactPreviewTarget | null>(null);
  const canvas = useCanvas()

  const artifacts = visibleDeliveryArtifacts(delivery.artifacts)
  if (artifacts.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {artifacts.map((artifact) => (
        <DeliveryArtifactCard
          key={`${artifact.runId}\u0000${artifact.path}`}
          artifact={artifact}
          onOpenPreview={canvas?.open ?? setPreviewTarget}
        />
      ))}

      {!canvas ? <ArtifactPreviewSheet
        open={previewTarget !== null}
        target={previewTarget}
        onOpenArtifact={setPreviewTarget}
        onOpenChange={(open) => {
          if (!open) setPreviewTarget(null);
        }}
      /> : null}
    </div>
  );
}

function DeliveryArtifactCard({
  artifact,
  onOpenPreview,
}: {
  artifact: ChatDeliveryArtifact;
  onOpenPreview: (target: ArtifactPreviewTarget) => void;
}) {
  const isFinal = artifact.role === "final";
  const title = artifact.title ?? artifact.path;
  const isArchive = /\.zip$/i.test(artifact.path) || artifact.mediaType === "application/zip";
  const preview = { artifactPath: artifact.path, runId: artifact.runId };

  return (
    <section className="rounded-lg border border-border/60 bg-secondary p-3">
      <div className="flex items-center gap-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
          title={artifact.path}
        >
          {title}
        </span>
        {!isFinal ? (
          <Badge variant="outline">Supporting file</Badge>
        ) : null}
      </div>

      {isArchive || /\.docx$/i.test(artifact.path) || /\.(?:mp4|webm)$/i.test(artifact.path) || artifact.mediaType?.startsWith("video/") ? (
        <div className="mt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            render={
              <a
                aria-label={`Download ${artifact.path}`}
                download={artifact.path.split("/").at(-1)}
                href={artifactUrl(artifact.runId, artifact.path)}
              />
            }
          >
            <Download className="size-3.5" />
            Download {artifact.path.split("/").at(-1)}
          </Button>
          {!isArchive ? <CanvasBinaryAction target={preview} /> : null}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => onOpenPreview(preview)}
        >
          Open full view
        </Button>
      )}
    </section>
  );
}

function CanvasBinaryAction({ target }: { target: ArtifactPreviewTarget }) {
  const canvas = useCanvas()
  return canvas ? <Button className="ml-2" variant="outline" size="sm" onClick={() => canvas.open(target)}>Open in Canvas</Button> : null
}
