import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProviderCatalogProvider, useProviderCatalog } from '../provider-catalog-context'

function Viewer() {
  const { groups, loading, refresh, error } = useProviderCatalog()
  return <><div>{loading ? 'Loading models' : groups.map(group => group.name).join(', ')}</div><button onClick={() => void refresh()}>Refresh catalog</button>{error ? <p role="status">{error}</p> : null}</>
}
function payload(name: string) {
  return new Response(JSON.stringify({ catalog: [{ provider: 'qwen', name, icon: 'qwen', source: 'cli', models: [] }], defaultModel: null, defaultModelState: { status: 'unset' } }), { status: 200 })
}
afterEach(() => vi.unstubAllGlobals())

it('shows saved models while background discovery waits, then shows the refreshed catalog', async () => {
  let finish: (response: Response) => void = () => {}
  const pending = new Promise<Response>(resolve => { finish = resolve })
  // Intercept the HTTP boundary: installed CLI discovery is nondeterministic.
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).includes('refresh=1') ? pending : Promise.resolve(payload('Saved catalog'))))
  render(<ProviderCatalogProvider><Viewer /></ProviderCatalogProvider>)
  expect(await screen.findByText('Saved catalog')).toBeInTheDocument()
  await act(async () => { finish(payload('Fresh catalog')); await pending })
  expect(await screen.findByText('Fresh catalog')).toBeInTheDocument()
})

it('keeps a newer catalog when an earlier discovery response arrives last', async () => {
  let finish: (response: Response) => void = () => {}
  const pending = new Promise<Response>(resolve => { finish = resolve })
  let refreshes = 0
  // HTTP interception models two responses completing out of order.
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    if (!String(input).includes('refresh=1')) return Promise.resolve(payload('Saved catalog'))
    refreshes += 1
    return refreshes === 1 ? pending : Promise.resolve(payload('Newest catalog'))
  }))
  render(<ProviderCatalogProvider><Viewer /></ProviderCatalogProvider>)
  await screen.findByText('Saved catalog')
  fireEvent.click(screen.getByText('Refresh catalog'))
  expect(await screen.findByText('Newest catalog')).toBeInTheDocument()
  await act(async () => { finish(payload('Obsolete catalog')); await pending })
  expect(screen.getByText('Newest catalog')).toBeInTheDocument()
})

it('keeps saved models usable when background refresh fails', async () => {
  // Only the HTTP boundary fails; the cached response remains available.
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).includes('refresh=1')
    ? Promise.resolve(new Response(JSON.stringify({ error: 'Discovery unavailable' }), { status: 503 }))
    : Promise.resolve(payload('Saved catalog'))))
  render(<ProviderCatalogProvider><Viewer /></ProviderCatalogProvider>)
  expect(await screen.findByRole('status')).toHaveTextContent('Discovery unavailable')
  expect(screen.getByText('Saved catalog')).toBeInTheDocument()
  expect(screen.queryByText('Loading models')).not.toBeInTheDocument()
})
