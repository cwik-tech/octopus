import * as path from 'node:path'
interface Work { readonly controller: AbortController; readonly done: Promise<void>; readonly finish: () => void }
const active = new Map<string, Set<Work>>()
const closed = new Map<string, number>()
const closingObservers = new Set<(scope: string) => void>()
export function observeSessionWorkClosing(observer: (scope: string) => void): void { closingObservers.add(observer) }
const key = (workspace: string, sessionId: string): string => JSON.stringify([path.resolve(workspace), sessionId])
export function sessionWorkClosed(workspace: string, sessionId: string): boolean { return closed.has(key(workspace, sessionId)) }
export function beginSessionWork(workspace: string, sessionId: string, signal: AbortSignal): { signal: AbortSignal; finish: () => void } | undefined {
  const identity = key(workspace, sessionId)
  if (closed.has(identity) || signal.aborted) return undefined
  const controller = new AbortController()
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => { finish = resolve })
  const work: Work = { controller, done, finish }
  const jobs = active.get(identity) ?? new Set<Work>()
  jobs.add(work); active.set(identity, jobs)
  return { signal: AbortSignal.any([signal, controller.signal]), finish: () => { jobs.delete(work); if (!jobs.size) active.delete(identity); finish() } }
}
/** Close admission while the caller holds the lifecycle lock; drain outside it. */
export function closeSessionWork(workspace: string, sessionId: string): { drain: () => Promise<boolean>; reopen: () => void } {
  const identity = key(workspace, sessionId)
  closed.set(identity, (closed.get(identity) ?? 0) + 1)
  for (const observer of closingObservers) observer(identity)
  const jobs = [...(active.get(identity) ?? [])]
  for (const work of jobs) work.controller.abort()
  return {
    drain: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([Promise.all(jobs.map((job) => job.done)).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5000) })]) }
      finally { clearTimeout(timer) }
    },
    reopen: () => { const count = (closed.get(identity) ?? 1) - 1; if (count) closed.set(identity, count); else closed.delete(identity) },
  }
}
