import { test, type ElectronApplication, type TestInfo } from '@playwright/test'

interface QuestionDesktop {
  app: ElectronApplication
  provider: { close(): Promise<void> }
}

export function agentQuestionDesktopTest<T extends QuestionDesktop>(prepare: (info: TestInfo) => Promise<T>) {
  return test.extend<{ desktop: T }>({
    // Explicit fixture time is separate from the unchanged 30-second journey.
    // Startup and teardown still share their own bounded lifecycle budget.
    desktop: [async ({}, use, info) => {
      const desktop = await prepare(info)
      try {
        await (await desktop.app.firstWindow()).getByRole('tab', { name: 'Run', exact: true }).waitFor({ state: 'visible' })
        await use(desktop)
      } finally {
        try { await desktop.app.close() } finally { await desktop.provider.close() }
      }
    }, { timeout: 30_000 }],
  })
}
