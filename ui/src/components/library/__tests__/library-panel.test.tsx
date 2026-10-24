import { act, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import LibraryPanel from '@/components/library/library-panel'
import type { SessionSummary, WorkspaceProject } from '@/lib/models/session-model'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const ARCHIVED_PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const NEW_PROJECT_ID = '33333333-3333-4333-8333-333333333333'
let detailsFailuresRemaining = 0
const SESSION: SessionSummary = {
  id: 'session-1',
  title: 'Market research',
  status: 'idle',
  activityType: 'chat',
  projectId: PROJECT_ID,
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T11:00:00.000Z',
}
const UNGROUPED_SESSION: SessionSummary = {
  id: 'session-2',
  title: 'Competitive scan',
  status: SESSION.status,
  activityType: SESSION.activityType,
  createdAt: SESSION.createdAt,
  updatedAt: SESSION.updatedAt,
}

const PROJECT: WorkspaceProject = {
  version: 1,
  id: PROJECT_ID,
  name: 'Acme launch',
  description: 'Launch planning and source material.',
  status: 'active',
  createdAt: '2026-08-04T09:00:00.000Z',
  updatedAt: '2026-08-04T11:00:00.000Z',
}

function TestLibraryPanel({
  sessions,
  initialSelectedProjectId = PROJECT_ID,
  onCreateProjectActionChange,
  onOpenSession,
  onProjectDeleted = vi.fn(),
  onSessionsChanged = vi.fn(),
  onSessionUpdated,
}: {
  sessions: SessionSummary[]
  initialSelectedProjectId?: string | null
  onCreateProjectActionChange: (action: (() => void) | null) => void
  onOpenSession: (sessionId: string) => void
  onProjectDeleted?: (projectId: string) => void
  onSessionsChanged?: () => void
  onSessionUpdated: (session: SessionSummary) => void
}) {
  const [projects, setProjects] = useState([
    { ...PROJECT, sessionCount: 1, activeSessionCount: 0 },
    {
      ...PROJECT,
      id: ARCHIVED_PROJECT_ID,
      name: 'Past work',
      status: 'archived' as const,
      archivedAt: '2026-08-04T12:00:00.000Z',
      sessionCount: 0,
      activeSessionCount: 0,
    },
  ])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialSelectedProjectId,
  )

  return (
    <LibraryPanel
      projects={projects}
      projectsError={null}
      projectsLoading={false}
      selectedProjectId={selectedProjectId}
      sessions={sessions}
      onCreateProjectActionChange={onCreateProjectActionChange}
      onOpenSession={onOpenSession}
      onProjectDeleted={(projectId) => {
        setProjects((current) => current.filter((project) => project.id !== projectId))
        setSelectedProjectId(null)
        onProjectDeleted(projectId)
      }}
      onProjectCreated={(project) => {
        setProjects((current) => [
          { ...project, sessionCount: 0, activeSessionCount: 0 },
          ...current,
        ])
        setSelectedProjectId(project.id)
      }}
      onProjectSelect={setSelectedProjectId}
      onProjectUpdated={(project) => {
        setProjects((current) =>
          current.map((existing) =>
            existing.id === project.id ? { ...existing, ...project } : existing,
          ),
        )
      }}
      onSessionsChanged={onSessionsChanged}
      onSessionUpdated={onSessionUpdated}
    />
  )
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('LibraryPanel', () => {
  beforeEach(() => {
    detailsFailuresRemaining = 0
    let briefContent = 'Launch goal: EU'
    let projectSessionConnected = true
    let ungroupedSessionConnected = false
    let createdProject: WorkspaceProject | null = null
    let memoryProposals = [
      {
        version: 1,
        id: 'mem_44444444-4444-4444-8444-444444444444',
        projectId: PROJECT_ID,
        content: 'The customer approved the European launch.',
        status: 'pending',
        createdAt: '2026-08-04T12:00:00.000Z',
      },
    ]
    let projectFiles = [
      {
        name: 'source.md',
        size: 12,
        uploadedAt: '2026-08-04T12:00:00.000Z',
        parseStatus: 'parsed',
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/projects?includeArchived=true')) {
        return jsonResponse({
          projects: [
            { ...PROJECT, sessionCount: 1, activeSessionCount: 0 },
            {
              ...PROJECT,
              id: ARCHIVED_PROJECT_ID,
              name: 'Past work',
              status: 'archived',
              archivedAt: '2026-08-04T12:00:00.000Z',
              sessionCount: 0,
              activeSessionCount: 0,
            },
          ],
        })
      }
      if (/\/projects\/[^/]+\/details$/.test(url)) {
        if (detailsFailuresRemaining > 0) {
          detailsFailuresRemaining -= 1
          return jsonResponse({ error: 'Project details are temporarily unavailable' }, 503)
        }
        const projectId = url.split('/').at(-2)
        const detailProject = projectId === NEW_PROJECT_ID && createdProject
          ? createdProject
          : projectId === ARCHIVED_PROJECT_ID
            ? {
                ...PROJECT,
                id: ARCHIVED_PROJECT_ID,
                name: 'Past work',
                status: 'archived' as const,
                archivedAt: '2026-08-04T12:00:00.000Z',
              }
            : PROJECT
        const detailSessions = projectId === PROJECT_ID
          ? [
              ...(projectSessionConnected ? [SESSION] : []),
              ...(ungroupedSessionConnected
                ? [{ ...UNGROUPED_SESSION, projectId: PROJECT_ID }]
                : []),
            ]
          : []
        const detailFiles = projectId === PROJECT_ID ? projectFiles : []
        const detailSchedules = projectId === PROJECT_ID
          ? [
              {
                id: 'schedule-1',
                name: 'Daily market scan',
                kind: 'agent',
                target: 'Web Researcher',
                projectId: PROJECT_ID,
                prompt: 'Scan the market',
                cron: '0 9 * * *',
                timezone: 'Europe/Warsaw',
                scheduleLabel: 'Every day at 09:00',
                overlap: 'skip',
                notifyOnFailure: true,
                enabled: true,
                createdAt: '2026-08-04T12:00:00.000Z',
                updatedAt: '2026-08-04T12:00:00.000Z',
                runtime: { nextFireAt: '2026-08-05T07:00:00.000Z' },
              },
            ]
          : []
        return jsonResponse({
          version: 1,
          project: {
            ...detailProject,
            sessionCount: detailSessions.length,
            activeSessionCount: 0,
          },
          brief: {
            content: projectId === PROJECT_ID ? briefContent : '',
            updatedAt: '2026-08-04T12:00:00.000Z',
          },
          files: detailFiles,
          catalog: {
            version: 1,
            projectId,
            sharedInputs: detailFiles.map((file) => ({
              id: `project_file:${file.name}`,
              name: file.name,
              category: 'shared_input',
              contentType: 'text/plain',
              capabilities: { preview: 'browser', download: true, delete: false },
              resource: {
                kind: 'project_file',
                projectId,
                filename: file.name,
                resourcePath: `/projects/${projectId}/files/${file.name}`,
              },
            })),
            sessions: detailSessions.map((session) => ({
              id: session.id,
              title: session.title,
              updatedAt: session.updatedAt,
            })),
          },
          sessions: detailSessions,
          schedules: detailSchedules,
          memoryProposals: projectId === PROJECT_ID ? memoryProposals : [],
        })
      }
      if (url.endsWith('/schedules')) {
        return jsonResponse({
          schedules: [
            {
              id: 'schedule-1',
              name: 'Daily market scan',
              kind: 'agent',
              target: 'Web Researcher',
              projectId: PROJECT_ID,
              prompt: 'Scan the market',
              cron: '0 9 * * *',
              timezone: 'Europe/Warsaw',
              scheduleLabel: 'Every day at 09:00',
              overlap: 'skip',
              notifyOnFailure: true,
              enabled: true,
              createdAt: '2026-08-04T12:00:00.000Z',
              updatedAt: '2026-08-04T12:00:00.000Z',
              runtime: { nextFireAt: '2026-08-05T07:00:00.000Z' },
            },
          ],
        })
      }
      if (url.endsWith(`/projects/${PROJECT_ID}/sessions`)) {
        return jsonResponse({ sessions: projectSessionConnected ? [SESSION] : [] })
      }
      if (url.endsWith(`/projects/${ARCHIVED_PROJECT_ID}/sessions`)) {
        return jsonResponse({ sessions: [] })
      }
      if (url.endsWith(`/projects/${NEW_PROJECT_ID}/sessions`)) {
        return jsonResponse({ sessions: [] })
      }
      if (/\/projects\/[^/]+\/catalog$/.test(url)) {
        const projectId = url.split('/').at(-2)
        return jsonResponse({
          version: 1,
          projectId,
          sharedInputs: projectFiles.map((file) => ({
            id: `project_file:${file.name}`,
            name: file.name,
            category: 'shared_input',
            contentType: 'text/plain',
            capabilities: { preview: 'browser', download: true, delete: false },
            resource: {
              kind: 'project_file',
              projectId,
              filename: file.name,
              resourcePath: `/projects/${projectId}/files/${file.name}`,
            },
          })),
          sessions: projectSessionConnected
            ? [{ id: SESSION.id, title: SESSION.title, updatedAt: SESSION.updatedAt }]
            : [],
        })
      }
      if (url.endsWith(`/projects/${PROJECT_ID}/catalog/sessions/${SESSION.id}`)) {
        return jsonResponse({
          version: 1,
          projectId: PROJECT_ID,
          sessionId: SESSION.id,
          inputs: [],
          deliveries: [
            {
              id: 'run_artifact:stale-output.md',
              name: 'stale-output.md',
              category: 'delivery',
              contentType: 'text/markdown',
              capabilities: { preview: 'artifact', download: true, delete: false },
              resource: {
                kind: 'run_artifact',
                runId: 'run-1',
                artifactPath: 'stale-output.md',
                resourcePath: '/runs/run-1/assignments/stale-output.md',
              },
            },
          ],
          artifacts: [
            {
              id: 'run_artifact:chain-step-1-brief-builder.md',
              name: 'chain-step-1-brief-builder.md',
              category: 'artifact',
              contentType: 'text/markdown',
              capabilities: { preview: 'artifact', download: true, delete: false },
              resource: {
                kind: 'run_artifact',
                runId: 'run-1',
                artifactPath: 'chain-step-1-brief-builder.md',
                resourcePath: '/runs/run-1/assignments/chain-step-1-brief-builder.md',
              },
            },
          ],
          evidence: [],
        })
      }
      if (/\/projects\/[^/]+\/memory-proposals(?:\?.*)?$/.test(url)) {
        return jsonResponse({ proposals: memoryProposals })
      }
      if (/\/projects\/[^/]+\/memory-proposals\/[^/]+\/approve$/.test(url)) {
        memoryProposals = memoryProposals.map((proposal) => ({
          ...proposal,
          status: 'approved',
          decidedAt: '2026-08-04T12:05:00.000Z',
        }))
        return jsonResponse(memoryProposals[0])
      }
      if (/\/projects\/[^/]+\/memory-proposals\/[^/]+\/reject$/.test(url)) {
        memoryProposals = memoryProposals.map((proposal) => ({
          ...proposal,
          status: 'rejected',
          decidedAt: '2026-08-04T12:05:00.000Z',
        }))
        return jsonResponse(memoryProposals[0])
      }
      if (/\/projects\/[^/]+\/brief$/.test(url)) {
        if (init?.method === 'PUT') {
          briefContent = (JSON.parse(String(init.body)) as { content: string }).content
        }
        return jsonResponse({
          content: briefContent,
          updatedAt: '2026-08-04T12:00:00.000Z',
        })
      }
      if (/\/projects\/[^/]+\/files$/.test(url)) {
        if (init?.method === 'POST') {
          const headers = init.headers as Record<string, string>
          const name = decodeURIComponent(String(headers['x-filename']))
          const file = {
            name,
            size: Number((init.body as ArrayBuffer)?.byteLength ?? 0),
            uploadedAt: '2026-08-04T12:00:00.000Z',
            parseStatus: 'parsed',
          }
          projectFiles = [...projectFiles, file]
          return jsonResponse(file, 201)
        }
        return jsonResponse({ files: projectFiles })
      }
      if (/\/projects\/[^/]+\/files\/[^/]+$/.test(url) && init?.method === 'DELETE') {
        const name = decodeURIComponent(url.split('/').at(-1) ?? '')
        projectFiles = projectFiles.filter((file) => file.name !== name)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/projects') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string; description?: string }
        createdProject = {
          version: 1,
          id: NEW_PROJECT_ID,
          name: body.name,
          status: PROJECT.status,
          createdAt: PROJECT.createdAt,
          updatedAt: PROJECT.updatedAt,
          ...(body.description === undefined ? {} : { description: body.description }),
        }
        return jsonResponse(createdProject, 201)
      }
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { projectId?: string }
        return jsonResponse({
          ...SESSION,
          id: 'session-new',
          title: 'Untitled chat',
          projectId: body.projectId,
        }, 201)
      }
      if (url.endsWith(`/projects/${PROJECT_ID}`) && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as {
          name?: string
          description?: string
          status?: 'active' | 'archived'
        }
        return jsonResponse({
          ...PROJECT,
          ...body,
          ...(body.status === 'archived'
            ? { archivedAt: '2026-08-04T12:00:00.000Z' }
            : { archivedAt: undefined }),
        })
      }
      if (url.endsWith(`/projects/${PROJECT_ID}`) && init?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      if (
        url.endsWith(`/projects/${PROJECT_ID}/sessions/session-2`) &&
        init?.method === 'PUT'
      ) {
        ungroupedSessionConnected = true
        return jsonResponse({
          version: 1,
          projectId: PROJECT_ID,
          sessionId: 'session-2',
          assignedAt: '2026-08-04T12:00:00.000Z',
          updatedAt: '2026-08-04T12:00:00.000Z',
        })
      }
      if (
        url.endsWith(`/projects/${PROJECT_ID}/sessions/session-2`) &&
        init?.method === 'DELETE'
      ) {
        ungroupedSessionConnected = false
        return new Response(null, { status: 204 })
      }
      if (
        url.endsWith(`/projects/${PROJECT_ID}/sessions/${SESSION.id}`) &&
        init?.method === 'DELETE'
      ) {
        projectSessionConnected = false
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`)
    }))
  })

  it('opens with every project in the center, then opens the selected project', async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn()

    render(
      <TestLibraryPanel
        initialSelectedProjectId={null}
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={onOpenSession}
        onSessionUpdated={vi.fn()}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Active projects' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Archived' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Acme launch' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Open Acme launch/ }))

    expect(await screen.findByRole('heading', { name: 'Acme launch' })).toBeInTheDocument()
    expect(screen.getByText('Launch planning and source material.')).toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: /Open Market research in Run/ }))
    expect(onOpenSession).toHaveBeenCalledWith('session-1')
  })

  it('loads the selected project with one aggregate detail request', async () => {
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    expect(await screen.findByText('Launch goal: EU')).toBeInTheDocument()
    expect(await screen.findByText('Daily market scan')).toBeInTheDocument()

    const initialReadUrls = vi.mocked(fetch).mock.calls
      .filter(([, init]) => !init?.method || init.method === 'GET')
      .map(([input]) => String(input))
    expect(
      initialReadUrls.filter((url) => url.endsWith(`/projects/${PROJECT_ID}/details`)),
    ).toEqual([`/api/projects/${PROJECT_ID}/details`])
    expect(
      initialReadUrls.filter((url) =>
        url.endsWith('/schedules') ||
        new RegExp(
          `/projects/${PROJECT_ID}/(?:brief|files|catalog|sessions|memory-proposals)$`,
        ).test(url),
      ),
    ).toEqual([])
  })

  it('offers a retry when the initial aggregate detail request fails', async () => {
    detailsFailuresRemaining = 1
    const user = userEvent.setup()
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('Project details are temporarily unavailable')
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Retry project details' }))

    expect(await screen.findByText('Launch goal: EU')).toBeInTheDocument()
    expect(screen.queryByText('Project details are temporarily unavailable')).not.toBeInTheDocument()
  })

  it('aborts stale aggregate detail work when the selected project changes', async () => {
    let firstRequestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith(`/projects/${PROJECT_ID}/details`)) {
        firstRequestSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          firstRequestSignal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }
      if (url.endsWith(`/projects/${ARCHIVED_PROJECT_ID}/details`)) {
        return jsonResponse({
          version: 1,
          project: {
            ...PROJECT,
            id: ARCHIVED_PROJECT_ID,
            name: 'Past work',
            status: 'archived',
            archivedAt: '2026-08-04T12:00:00.000Z',
            sessionCount: 0,
            activeSessionCount: 0,
          },
          brief: { content: '', updatedAt: PROJECT.updatedAt },
          files: [],
          catalog: {
            version: 1,
            projectId: ARCHIVED_PROJECT_ID,
            sharedInputs: [],
            sessions: [],
          },
          sessions: [],
          schedules: [],
          memoryProposals: [],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    const projects = [
      { ...PROJECT, sessionCount: 1, activeSessionCount: 0 },
      {
        ...PROJECT,
        id: ARCHIVED_PROJECT_ID,
        name: 'Past work',
        status: 'archived' as const,
        archivedAt: '2026-08-04T12:00:00.000Z',
        sessionCount: 0,
        activeSessionCount: 0,
      },
    ]
    const commonProps = {
      projects,
      projectsError: null,
      projectsLoading: false,
      sessions: [SESSION],
      onCreateProjectActionChange: vi.fn(),
      onOpenSession: vi.fn(),
      onProjectCreated: vi.fn(),
      onProjectDeleted: vi.fn(),
      onProjectSelect: vi.fn(),
      onProjectUpdated: vi.fn(),
      onSessionsChanged: vi.fn(),
      onSessionUpdated: vi.fn(),
    }
    const { rerender } = render(
      <LibraryPanel {...commonProps} selectedProjectId={PROJECT_ID} />,
    )
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled()
    })

    rerender(
      <LibraryPanel {...commonProps} selectedProjectId={ARCHIVED_PROJECT_ID} />,
    )

    await waitFor(() => expect(firstRequestSignal?.aborted).toBe(true))
    expect(await screen.findByRole('heading', { name: 'Past work' })).toBeInTheDocument()
  })

  it('constrains the project view so its center pane owns vertical scrolling', async () => {
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    await screen.findByRole('heading', { name: 'Acme launch' })
    const library = screen.getByRole('region', { name: 'Project library' })
    const centerPane = library.firstElementChild

    expect(library).toHaveClass('flex', 'h-full', 'min-h-0', 'flex-col')
    expect(centerPane).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto')
  })

  it('registers New project and creates a project-owned chat from the Add menu', async () => {
    const user = userEvent.setup()
    let newProjectAction: (() => void) | null = null
    const onOpenSession = vi.fn()
    const onSessionUpdated = vi.fn()

    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={(action) => {
          newProjectAction = action
        }}
        onOpenSession={onOpenSession}
        onSessionUpdated={onSessionUpdated}
      />,
    )

    await screen.findByRole('heading', { name: 'Acme launch' })
    await waitFor(() => expect(newProjectAction).toBeTypeOf('function'))
    act(() => newProjectAction?.())

    const createDialog = screen.getByRole('dialog', { name: 'New project' })
    expect(
      within(createDialog)
        .getByRole('button', { name: 'Create project' })
        .closest('[data-slot="dialog-footer"]'),
    ).toBeNull()
    await user.type(within(createDialog).getByLabelText('Project name'), 'Northwind')
    await user.type(within(createDialog).getByLabelText('Description'), 'Renewal work')
    await user.click(within(createDialog).getByRole('button', { name: 'Create project' }))
    expect(await screen.findByRole('heading', { name: 'Northwind' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add to project' }))
    await user.click(await screen.findByRole('menuitem', { name: 'New chat' }))

    await waitFor(() => {
      expect(onSessionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'session-new', projectId: NEW_PROJECT_ID }),
      )
      expect(onOpenSession).toHaveBeenCalledWith('session-new')
    })
    const sessionRequest = vi.mocked(fetch).mock.calls.find(([, init]) =>
      String(init?.method).toUpperCase() === 'POST' && String(init?.body).includes('projectId'),
    )
    expect(JSON.parse(String(sessionRequest?.[1]?.body))).toEqual({ projectId: NEW_PROJECT_ID })
  })

  it('does not advertise an unavailable workflow-run action', async () => {
    const user = userEvent.setup()

    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    await screen.findByRole('heading', { name: 'Acme launch' })
    await user.click(screen.getByRole('button', { name: 'Add to project' }))
    await screen.findByText('New chat')

    expect(screen.queryByText('New workflow run')).not.toBeInTheDocument()
  })

  it('uses vertical project actions and keeps every action label on one line', async () => {
    const user = userEvent.setup()

    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    await screen.findByRole('heading', { name: 'Acme launch' })
    const projectActions = screen.getByRole('button', { name: 'Project actions' })
    expect(projectActions.querySelector('svg')).toHaveClass('lucide-ellipsis-vertical')

    await user.click(projectActions)
    expect(await screen.findByRole('menu')).toHaveClass('whitespace-nowrap')
  })

  it('expands file-tree branches and subbranches when their titles are clicked', async () => {
    const user = userEvent.setup()

    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    const fileCatalog = await screen.findByRole('region', { name: 'File catalog' })
    await user.click(within(fileCatalog).getByRole('button', { name: 'Market research' }))
    expect(await within(fileCatalog).findByText('stale-output.md')).toBeInTheDocument()

    await user.click(within(fileCatalog).getByRole('button', { name: 'Deliveries' }))
    expect(within(fileCatalog).queryByText('stale-output.md')).not.toBeInTheDocument()
    await user.click(within(fileCatalog).getByRole('button', { name: 'Deliveries' }))
    expect(await within(fileCatalog).findByText('stale-output.md')).toBeInTheDocument()
  })

  it('places Sessions immediately before the file catalog', async () => {
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    const sessionsHeading = await screen.findByRole('heading', { name: /^Sessions$/ })
    const fileCatalog = await screen.findByRole('region', { name: 'File catalog' })
    const sessionsSection = sessionsHeading.closest('section')

    expect(sessionsSection).not.toBeNull()
    expect(sessionsSection?.nextElementSibling).toBe(fileCatalog)
  })

  it('hides intermediate artifacts until Show Hidden Files is enabled', async () => {
    const user = userEvent.setup()

    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    const fileCatalog = await screen.findByRole('region', { name: 'File catalog' })
    await user.click(within(fileCatalog).getByRole('button', { name: 'Expand Market research' }))
    expect(await within(fileCatalog).findByText('stale-output.md')).toBeInTheDocument()
    expect(
      within(fileCatalog).queryByText('chain-step-1-brief-builder.md'),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    const visibilityToggle = await screen.findByRole('menuitemcheckbox', {
      name: 'Show Hidden Files',
    })
    expect(visibilityToggle).not.toBeChecked()
    await user.click(visibilityToggle)

    expect(
      await within(fileCatalog).findByText('chain-step-1-brief-builder.md'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    expect(
      await screen.findByRole('menuitemcheckbox', { name: 'Show Hidden Files' }),
    ).toBeChecked()
  })

  it('edits, archives, restores, assigns, and removes membership accessibly', async () => {
    const user = userEvent.setup()
    const onSessionUpdated = vi.fn<(session: SessionSummary) => void>()

    render(
      <TestLibraryPanel
        sessions={[SESSION, UNGROUPED_SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={onSessionUpdated}
      />,
    )

    await screen.findByRole('heading', { name: 'Acme launch' })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const editDialog = screen.getByRole('dialog', { name: 'Edit project' })
    const nameInput = within(editDialog).getByLabelText('Project name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Acme relaunch')
    await user.click(within(editDialog).getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('heading', { name: 'Acme relaunch' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }))
    expect(await screen.findByText('Archived')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add to project' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }))
    await waitFor(() => expect(screen.queryByText('Archived')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Add to project' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add existing session' }))
    const sessionDialog = screen.getByRole('dialog', { name: 'Add existing session' })
    await user.click(within(sessionDialog).getByRole('button', { name: 'Competitive scan' }))
    expect(onSessionUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'session-2', projectId: PROJECT_ID }),
    )

    await user.click(
      await screen.findByRole('button', { name: 'Remove Competitive scan from project' }),
    )
    // Removed from the project means no projectId at all, not one set to
    // undefined: the session schema keeps a missing optional field missing.
    await waitFor(() => {
      const removed = onSessionUpdated.mock.lastCall?.[0]
      expect(removed).toMatchObject({ id: 'session-2' })
      expect(removed).not.toHaveProperty('projectId')
    })
  })

  it('shows a top-positioned disconnect tooltip for a project session', async () => {
    const user = userEvent.setup()
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    const disconnect = await screen.findByRole('button', {
      name: 'Remove Market research from project',
    })
    await user.hover(disconnect)

    await waitFor(() => {
      const tooltip = document.querySelector('[data-slot="tooltip-content"][data-open]')
      expect(tooltip).toHaveTextContent('Disconnect from Project')
      expect(tooltip?.parentElement).toHaveAttribute('data-side', 'top')
    })
  })

  it('reloads the file catalog after disconnecting a session', async () => {
    const user = userEvent.setup()
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    const fileCatalog = await screen.findByRole('region', { name: 'File catalog' })
    await user.click(within(fileCatalog).getByRole('button', { name: 'Expand Market research' }))
    expect(await within(fileCatalog).findByText('stale-output.md')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove Market research from project' }))

    await waitFor(() => {
      expect(within(fileCatalog).queryByText('stale-output.md')).not.toBeInTheDocument()
      expect(within(fileCatalog).getByText('No project sessions')).toBeInTheDocument()
    })
  })

  it('edits the curated brief and uploads shared files without changing Run', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    expect(await screen.findByText('Launch goal: EU')).toBeInTheDocument()
    const sharedFiles = screen.getByRole('heading', { name: 'Shared files' }).closest('section')
    expect(sharedFiles).not.toBeNull()
    expect(await within(sharedFiles!).findByText('source.md')).toBeInTheDocument()
    const fileCatalog = screen.getByRole('region', { name: 'File catalog' })
    expect(within(fileCatalog).getByText('source.md')).toBeInTheDocument()
    await user.click(within(fileCatalog).getByRole('button', { name: 'Expand Market research' }))
    expect(await within(fileCatalog).findByText('stale-output.md')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit project brief' }))
    const briefEditor = screen.getByLabelText('Project brief')
    await user.clear(briefEditor)
    await user.type(briefEditor, 'Launch goal: Europe and UK')
    await user.click(screen.getByRole('button', { name: 'Save project brief' }))
    expect(await screen.findByText('Launch goal: Europe and UK')).toBeInTheDocument()

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    await user.upload(
      input!,
      new File(['customer evidence'], 'new-source.txt', { type: 'text/plain' }),
    )
    expect(await within(sharedFiles!).findByText('new-source.txt')).toBeInTheDocument()
    expect(await within(fileCatalog).findByText('new-source.txt')).toBeInTheDocument()
    expect(
      within(fileCatalog).getByRole('button', { name: 'Collapse Market research' }),
    ).toBeInTheDocument()
    expect(within(fileCatalog).getByText('stale-output.md')).toBeInTheDocument()

    const briefRequest = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(briefRequest?.[1]?.body))).toEqual({
      content: 'Launch goal: Europe and UK',
    })
  })

  it('requires an explicit Library decision before project memory is approved', async () => {
    const user = userEvent.setup()
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    expect(
      await screen.findByText('The customer approved the European launch.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/never added to prompts automatically/i),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Approve project memory' }))

    await waitFor(() => {
      expect(screen.getByText('Approved memory')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Approve project memory' })).not.toBeInTheDocument()
    })
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `/api/projects/${PROJECT_ID}/memory-proposals/mem_44444444-4444-4444-8444-444444444444/approve`,
      { method: 'POST' },
    )
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) =>
        String(input).endsWith(`/projects/${PROJECT_ID}/details`),
      ),
    ).toHaveLength(2)
  })

  it('shows schedules owned by the selected project', async () => {
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Project schedules' })).toBeInTheDocument()
    expect(await screen.findByText('Daily market scan')).toBeInTheDocument()
    expect(screen.getByText('Every day at 09:00')).toBeInTheDocument()
  })

  it('starts a portable project export from the selected-project header', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onSessionUpdated={vi.fn()}
      />,
    )
    await screen.findByRole('heading', { name: 'Acme launch' })

    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Export' }))

    expect(open).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/export`, '_blank', 'noopener,noreferrer')
  })

  it('confirms whether deleting a project preserves or deletes its sessions', async () => {
    const user = userEvent.setup()
    const onProjectDeleted = vi.fn()
    const onSessionsChanged = vi.fn()
    render(
      <TestLibraryPanel
        sessions={[SESSION]}
        onCreateProjectActionChange={vi.fn()}
        onOpenSession={vi.fn()}
        onProjectDeleted={onProjectDeleted}
        onSessionsChanged={onSessionsChanged}
        onSessionUpdated={vi.fn()}
      />,
    )
    await screen.findByRole('heading', { name: 'Acme launch' })

    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete Project' }))

    const dialog = screen.getByRole('dialog', { name: 'Delete project?' })
    expect(within(dialog).getByText(/Are you sure/i)).toBeInTheDocument()
    expect(
      within(dialog).getByRole('radio', { name: /Leave session data ungrouped/i }),
    ).toBeChecked()
    const deleteEverything = within(dialog).getByRole('radio', {
      name: /Delete all data and chats/i,
    })
    await user.click(deleteEverything)
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }))

    await waitFor(() => {
      expect(onProjectDeleted).toHaveBeenCalledWith(PROJECT_ID)
      expect(onSessionsChanged).toHaveBeenCalledOnce()
    })
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `/api/projects/${PROJECT_ID}`,
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ mode: 'delete_sessions' }),
      }),
    )
    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument()
  })
})
