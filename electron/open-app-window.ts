/** Only the native window lifecycle is injected; callers own renderer loading. */
interface LoadingWindow {
  destroy(): void
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}
export function openAppWindow<W extends LoadingWindow>(options: {
  create: () => W
  load: (window: W) => Promise<void>
  timeoutMs: number
  setTimer: (callback: () => void, ms: number) => () => void
}): Promise<void> {
  const window = options.create()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let cancelTimer = () => {}
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cancelTimer()
      window.removeListener('closed', onClosed)
      if (error) {
        if (!window.isDestroyed()) window.destroy()
        reject(error)
      } else resolve()
    }
    const onClosed = () => finish(new Error('New window closed before loading'))
    window.once('closed', onClosed)
    cancelTimer = options.setTimer(() => finish(new Error('New window load timed out')), options.timeoutMs)
    // Both outcomes are handled even when timeout or close wins the race.
    void Promise.resolve().then(() => options.load(window)).then(() => finish(), (cause: unknown) => finish(new Error('New window failed to load', { cause })))
  })
}
