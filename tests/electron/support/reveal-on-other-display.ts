import type { ElectronApplication } from '@playwright/test'

/** Show only after placement; a missing alternate display leaves tests hidden. */
export async function revealOnOtherDisplay(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ app, BrowserWindow, screen }) => {
    const current = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const other = screen.getAllDisplays().find((display) => display.id !== current.id)
    if (!other) return false
    const area = other.workArea
    const show = (window: InstanceType<typeof BrowserWindow>) => {
      if (window.isDestroyed()) return
      const bounds = window.getBounds()
      const width = Math.min(bounds.width, area.width)
      const height = Math.min(bounds.height, area.height)
      window.setMinimumSize(Math.min(1100, width), Math.min(720, height))
      window.setBounds({ width, height,
        x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
      })
      window.showInactive()
    }
    for (const window of BrowserWindow.getAllWindows()) show(window)
    app.on('browser-window-created', (_event, window) => { window.once('ready-to-show', () => show(window)) })
    return true
  })
}
