const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

const BATCH_FOLDER_PICKER_CHANNEL = 'pipeline:select-batch-folder'
const SHARED_FOLDER_PICKER_CHANNEL = 'pipeline:select-shared-folder'
const SHARED_FOLDER_OPENER_CHANNEL = 'pipeline:open-shared-folder'
const VOICE_NAVIGATE_CHANNEL = 'pipeline:voice-navigate'
const VOICE_SESSION_CHANGED_CHANNEL = 'pipeline:voice-session-changed'
// Mirrored constants: the sandboxed preload cannot load application modules.
const GET_CANVAS_WINDOW_STATE_CHANNEL = 'pipeline:get-canvas-window-state'
const CANVAS_WINDOW_STATE_CHANNEL = 'pipeline:canvas-window-state'

contextBridge.exposeInMainWorld('pipeline', {
  getCanvasWindowState: (sessionId: unknown) => ipcRenderer.invoke(GET_CANVAS_WINDOW_STATE_CHANNEL, sessionId),
  onCanvasWindowState: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state)
    ipcRenderer.on(CANVAS_WINDOW_STATE_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CANVAS_WINDOW_STATE_CHANNEL, handler)
  },
  openWindow: (request: unknown) => ipcRenderer.invoke('pipeline:open-window', request),
  reportWindowSession: (sessionId: unknown) => ipcRenderer.send('pipeline:report-window-session', sessionId),
  announceSessionChanged: (sessionId: unknown) => ipcRenderer.send('pipeline:announce-session-changed', sessionId),
  selectBatchFolder: () => ipcRenderer.invoke(BATCH_FOLDER_PICKER_CHANNEL),
  selectSharedFolder: () => ipcRenderer.invoke(SHARED_FOLDER_PICKER_CHANNEL),
  openSharedFolder: (folderPath: string) => ipcRenderer.invoke(SHARED_FOLDER_OPENER_CHANNEL, folderPath),
  /** Called when a voice layer asks to show a session. Returns the unsubscribe. */
  onVoiceNavigate: (listener: (target: unknown) => void) => {
    const handler = (_event: unknown, target: unknown) => listener(target)
    ipcRenderer.on(VOICE_NAVIGATE_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(VOICE_NAVIGATE_CHANNEL, handler)
    }
  },
  onVoiceSessionChanged: (listener: (target: unknown) => void) => {
    const handler = (_event: unknown, target: unknown) => listener(target)
    ipcRenderer.on(VOICE_SESSION_CHANGED_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(VOICE_SESSION_CHANGED_CHANNEL, handler)
    }
  },
})
