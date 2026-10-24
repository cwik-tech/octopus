import type {
  CancelGeneratorJobResponse,
  ChatTurn,
  GeneratorTurnCancelledResponse,
  GeneratorTurnResponse,
  SaveWorkflowResponse,
  ValidateWorkflowYamlResponse,
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from '@/lib/models/workflow-generator-model'
import {
  readArchitectTurnHistory,
  type ArchitectTurnRecord,
} from '@/lib/models/architect-turn-history'
import { getApiBaseUrl } from '@/lib/utils/desktop'

const API_BASE = getApiBaseUrl()

/** Long enough for a slow disk, short enough to stop waiting on a dead one. */
const HISTORY_TIMEOUT_MS = 10_000

function toUrl(path: string): string {
  return `${API_BASE}${path}`
}

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response
  const fallback = `${response.status} ${response.statusText}`
  try {
    const payload = (await response.json()) as { error?: string; details?: string[] }
    const detailSuffix =
      Array.isArray(payload.details) && payload.details.length > 0
        ? `: ${payload.details.join('; ')}`
        : ''
    throw new Error(`${payload.error || fallback}${detailSuffix}`)
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error(fallback, { cause: error })
  }
}

/**
 * How past Architect turns chose their model.
 *
 * Validated rather than cast: this arrives over HTTP from a store on disk, and
 * a half-read record would put a claim on screen that no turn recorded. The
 * decoding lives in one pure place so the panel does not repeat it.
 */
export async function fetchArchitectTurnHistory(
  limit = 50,
  signal?: AbortSignal,
): Promise<ArchitectTurnRecord[]> {
  const response = await expectOk(
    await fetch(
      toUrl(
        `/create/workflow-architect/turns?limit=${encodeURIComponent(String(limit))}`,
      ),
      {
        cache: 'no-store',
        // Bounded, and cancellable by the caller. A history read that never
        // answers must not leave a panel waiting on it for the life of the
        // view.
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(HISTORY_TIMEOUT_MS)])
          : AbortSignal.timeout(HISTORY_TIMEOUT_MS),
      },
    ),
  )
  return readArchitectTurnHistory(await response.json())
}

export async function fetchGeneratorRegistry(): Promise<WorkflowGeneratorRegistry> {
  const response = await expectOk(await fetch(toUrl('/create/teams')))
  return (await response.json()) as WorkflowGeneratorRegistry
}

export async function postGeneratorTurn(input: {
  jobId: string
  history: ChatTurn[]
  currentDraft: WorkflowDraft | null
  provider?: string
  model?: string
}): Promise<GeneratorTurnResponse | GeneratorTurnCancelledResponse> {
  const response = await expectOk(
    await fetch(toUrl('/create/turn'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
  return (await response.json()) as GeneratorTurnResponse | GeneratorTurnCancelledResponse
}

/**
 * Reads a Stop acknowledgement.
 *
 * Validated rather than asserted, because the two halves are one statement.
 * A body pairing them differently is not a weaker acknowledgement but a
 * contradictory one — it would let a turn somebody stopped be reported as
 * finished, or a turn that finished be reported as stopped — so an
 * unrecognised pairing is refused rather than passed on as either.
 */
export function readCancelGeneratorJobResponse(
  value: unknown,
): CancelGeneratorJobResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The cancellation acknowledgement was not an object.')
  }
  const { jobId, cancelled, status } = value as {
    jobId?: unknown
    cancelled?: unknown
    status?: unknown
  }
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('The cancellation acknowledgement named no job.')
  }
  if (cancelled === true && status === 'cancelled') {
    return { jobId, cancelled: true, status: 'cancelled' }
  }
  if (cancelled === true && status === 'pending') {
    return { jobId, cancelled: true, status: 'pending' }
  }
  if (cancelled === false && status === 'completed') {
    return { jobId, cancelled: false, status: 'completed' }
  }
  throw new Error(
    `The cancellation acknowledgement for job '${jobId}' does not describe an outcome.`,
  )
}

export async function cancelGeneratorJob(
  jobId: string,
): Promise<CancelGeneratorJobResponse> {
  const response = await expectOk(
    await fetch(toUrl(`/create/jobs/${encodeURIComponent(jobId)}/cancel`), {
      method: 'POST',
    }),
  )
  return readCancelGeneratorJobResponse(await response.json())
}

export async function validateWorkflowYaml(input: {
  yaml: string
}): Promise<ValidateWorkflowYamlResponse> {
  const response = await expectOk(
    await fetch(toUrl('/create/validate-yaml'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
  return (await response.json()) as ValidateWorkflowYamlResponse
}

export async function saveGeneratorDraft(input: {
  draft?: WorkflowDraft
  yaml?: string
  filename?: string | undefined
  replaceWorkflowId?: string
}): Promise<SaveWorkflowResponse> {
  const response = await expectOk(
    await fetch(toUrl('/create/save'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
  return (await response.json()) as SaveWorkflowResponse
}

export async function revealGeneratorArtifact(input: {
  artifactPath: string
}): Promise<{ path: string }> {
  const response = await expectOk(
    await fetch(toUrl('/create/reveal-artifact'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
  return (await response.json()) as { path: string }
}
