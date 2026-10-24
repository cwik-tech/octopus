import { getApiBaseUrl } from '@/lib/utils/desktop'
import type { DeepResearchJourneySnapshot } from '@contracts/deep-research-journey'

export type {
  DeepResearchJourneyCorrectionRequest,
  DeepResearchJourneyFinding,
  DeepResearchJourneyPhase,
  DeepResearchJourneySnapshot,
  DeepResearchJourneyWorkerStatus,
} from '@contracts/deep-research-journey'

const API_BASE = getApiBaseUrl()

export async function fetchDeepResearchJourney(
  sessionId: string,
  taskId: string,
): Promise<DeepResearchJourneySnapshot> {
  const response = await fetch(
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/deep-research`,
  )
  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`
    try {
      const payload = await response.json() as { error?: string }
      throw new Error(payload.error || fallback)
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(fallback, { cause: error })
      throw error
    }
  }
  return response.json() as Promise<DeepResearchJourneySnapshot>
}
