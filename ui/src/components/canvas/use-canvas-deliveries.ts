import { visibleDeliveryArtifacts } from '@/lib/chat/visible-delivery-artifacts'
import { useEffect, useState } from 'react'
import type { ChatDeliveryArtifact, ChatMessage } from '@contracts/sessions'
import { canvasTabKey } from '@contracts/canvas-workspace'
import { useCanvas } from './canvas-context'

function previewableArtifacts(artifacts: readonly ChatDeliveryArtifact[]) {
  return visibleDeliveryArtifacts(artifacts).filter((artifact) => artifact.mediaType !== 'application/zip' && !/\.zip$/i.test(artifact.path))
}

function createDeliveryObservation(sessionId: string | null) {
  return { sessionId, since: Date.now(), seen: new Set<string>() }
}

/** Observe deliveries created during this visit; loading history never reopens closed tabs. */
export function useCanvasDeliveries(sessionId: string | null, messages: readonly Pick<ChatMessage, 'createdAt' | 'delivery'>[]): void {
  const canvas = useCanvas()
  const [visit, setVisit] = useState(() => createDeliveryObservation(sessionId))
  if (visit.sessionId !== sessionId) setVisit(createDeliveryObservation(sessionId))
  const open = canvas?.open
  const act = canvas?.act
  const tabs = canvas?.workspace.tabs
  useEffect(() => {
    if (!act || !tabs) return
    const artifacts = messages.flatMap((message) => message.delivery?.artifacts ?? [])
    const visible = new Set(messages.flatMap((message) => previewableArtifacts(message.delivery?.artifacts ?? [])).map((artifact) => canvasTabKey({ runId: artifact.runId, artifactPath: artifact.path })))
    const hidden = new Set(artifacts.map((artifact) => canvasTabKey({ runId: artifact.runId, artifactPath: artifact.path })).filter((key) => !visible.has(key)))
    for (const tab of tabs) if (hidden.has(canvasTabKey(tab))) act({ kind: 'close', key: canvasTabKey(tab) })
  }, [act, messages, tabs])
  useEffect(() => {
    if (!open || !sessionId || visit.sessionId !== sessionId) return
    for (const message of messages) {
      if (!(Date.parse(message.createdAt) >= visit.since)) continue
      for (const artifact of previewableArtifacts(message.delivery?.artifacts ?? [])) {
        const target = { runId: artifact.runId, artifactPath: artifact.path }
        const key = canvasTabKey(target)
        if (visit.seen.has(key)) continue
        visit.seen.add(key)
        open(target)
      }
    }
  }, [messages, open, sessionId, visit])
}
