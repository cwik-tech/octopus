export {}

declare global {
  interface Window {
    pipeline?: {
      openWindow?(request: { kind: "new-chat" } | { kind: "session" | "canvas"; sessionId: string }): Promise<void>
      getCanvasWindowState?(sessionId: string): Promise<unknown>
      onCanvasWindowState?(listener: (state: unknown) => void): () => void
      reportWindowSession?(sessionId: string | null): void
      announceSessionChanged?(sessionId: string): void
      selectBatchFolder(): Promise<{ path: string } | null>
      selectSharedFolder(): Promise<{ path: string } | null>
      /** Opens a granted shared folder in Finder or File Explorer. */
      openSharedFolder?(folderPath: string): Promise<{ opened: true }>
      /**
       * Subscribes to a voice layer's requests to show a session. The target
       * comes from the main process and is checked before use. Returns the
       * unsubscribe.
       */
      onVoiceNavigate?(listener: (target: unknown) => void): () => void
      /** Refreshes saved work only when the named chat is already open. */
      onVoiceSessionChanged?(listener: (target: unknown) => void): () => void
    }
  }
}
