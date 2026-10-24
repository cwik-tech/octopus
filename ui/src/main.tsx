import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ProviderCatalogProvider } from './contexts/provider-catalog-context.tsx'
import { CanvasWindow } from './components/canvas/canvas-window'
import { readInitialCanvasSessionId } from './lib/utils/desktop'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('The UI entry page has no #root element to mount into.')
const canvasSessionId = readInitialCanvasSessionId()

createRoot(rootElement).render(
  <StrictMode>
    <ProviderCatalogProvider>
      {canvasSessionId ? <CanvasWindow sessionId={canvasSessionId} /> : <App />}
    </ProviderCatalogProvider>
  </StrictMode>,
)
