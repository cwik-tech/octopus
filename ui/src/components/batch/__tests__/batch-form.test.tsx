import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BatchForm } from '@/components/batch/batch-form'

vi.mock('@/lib/clients/session-client', () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  listWorkflows: vi.fn(async () => [
    { id: 'eligible-workflow', tags: ['writing'] },
    { id: 'deep-research-report', tags: ['batch-ineligible'] },
  ]),
}))

vi.mock('@/lib/clients/project-client', () => ({
  listProjects: vi.fn(async () => [{
    version: 1,
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Acme',
    status: 'active',
    createdAt: '2026-08-06T10:00:00.000Z',
    updatedAt: '2026-08-06T10:00:00.000Z',
    sessionCount: 0,
    activeSessionCount: 0,
  }]),
}))

afterEach(() => {
  delete window.pipeline
})

describe('BatchForm', () => {
  it('creates a Batch from its workflow and files without asking for a prompt', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    window.pipeline = {
      selectBatchFolder: vi.fn(async () => ({ path: '/external/files' })),
      selectSharedFolder: vi.fn(async () => null),
    }
    render(<BatchForm onCancel={() => undefined} onSave={onSave} />)

    expect(screen.queryByLabelText('Prompt template')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Name'), 'Workflow runs')
    await user.click(screen.getByRole('button', { name: 'Choose folder' }))
    const workflow = screen.getByRole('combobox', { name: 'Workflow' })
    await waitFor(() => expect(workflow).not.toBeDisabled())
    await user.selectOptions(workflow, 'eligible-workflow')
    await user.click(screen.getByRole('button', { name: 'Create Batch' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      name: 'Workflow runs',
      workflowId: 'eligible-workflow',
      folderPath: '/external/files',
      fileExtensions: [],
      rerunPolicy: 'new_and_changed',
    }))
  })

  it('explains the extension filter through an accessible information tooltip', async () => {
    const user = userEvent.setup()
    render(<BatchForm onCancel={() => undefined} onSave={async () => undefined} />)

    const extensionHelp = screen.getByRole('button', { name: 'Help: file extensions' })
    await user.hover(extensionHelp)

    expect(await screen.findByText(/Choose which files become Batch items/)).toBeInTheDocument()
    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
      'Leave blank to include every eligible file',
    )
    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
      'nested folders, hidden files, symlinks, and _manifest.json are ignored',
    )
  })

  it('explains every rerun policy through an accessible information tooltip', async () => {
    const user = userEvent.setup()
    render(<BatchForm onCancel={() => undefined} onSave={async () => undefined} />)

    const rerunHelp = screen.getByRole('button', { name: 'Help: rerun policy' })
    await user.hover(rerunHelp)

    expect(await screen.findByText(/Controls which files are processed when you run this Batch again/)).toBeInTheDocument()
    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
      'New files only skips filenames that completed successfully before, even if their contents changed',
    )
    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
      'New and changed files processes new filenames and files whose contents changed',
    )
    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
      'Every matching file processes all eligible files on every run',
    )
    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
      'Failed or cancelled files are tried again, and renaming a file makes it new',
    )
  })

  it('uses the desktop picker and submits only an eligible workflow with normalized extensions', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    window.pipeline = {
      selectBatchFolder: vi.fn(async () => ({ path: '/external/files' })),
      selectSharedFolder: vi.fn(async () => null),
    }
    render(<BatchForm onCancel={() => undefined} onSave={onSave} />)

    await user.type(screen.getByLabelText('Name'), 'Quarterly files')
    await user.click(screen.getByRole('button', { name: 'Choose folder' }))
    expect(screen.getByLabelText('Folder')).toHaveValue('/external/files')
    const workflow = screen.getByRole('combobox', { name: 'Workflow' })
    await waitFor(() => expect(workflow).not.toBeDisabled())
    expect(screen.queryByRole('option', { name: /Deep Research/i })).not.toBeInTheDocument()
    await user.selectOptions(workflow, 'eligible-workflow')
    await user.type(screen.getByLabelText('Extensions'), 'PDF, .docx')
    await user.click(screen.getByRole('button', { name: 'Create Batch' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      name: 'Quarterly files',
      workflowId: 'eligible-workflow',
      folderPath: '/external/files',
      fileExtensions: ['.pdf', '.docx'],
      rerunPolicy: 'new_and_changed',
    }))
  })

  it('explains that folder selection is desktop-only when the preload is absent', async () => {
    render(<BatchForm onCancel={() => undefined} onSave={async () => undefined} />)
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeDisabled()
    expect(screen.getByText(/desktop app is required/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workflow' })).not.toBeDisabled())
  })

  it('allows an empty extension filter to process every supported file', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    window.pipeline = {
      selectBatchFolder: vi.fn(async () => ({ path: '/external/all-files' })),
      selectSharedFolder: vi.fn(async () => null),
    }
    render(<BatchForm onCancel={() => undefined} onSave={onSave} />)

    await user.type(screen.getByLabelText('Name'), 'All files')
    await user.click(screen.getByRole('button', { name: 'Choose folder' }))
    const workflow = screen.getByRole('combobox', { name: 'Workflow' })
    await waitFor(() => expect(workflow).not.toBeDisabled())
    await user.selectOptions(workflow, 'eligible-workflow')
    await user.click(screen.getByRole('button', { name: 'Create Batch' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      fileExtensions: [],
    })))
  })

  it('leaves the folder unchanged when the native picker is cancelled', async () => {
    const user = userEvent.setup()
    window.pipeline = {
      selectBatchFolder: vi.fn(async () => null),
      selectSharedFolder: vi.fn(async () => null),
    }
    render(<BatchForm onCancel={() => undefined} onSave={async () => undefined} />)

    await user.click(screen.getByRole('button', { name: 'Choose folder' }))

    expect(screen.getByLabelText('Folder')).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
