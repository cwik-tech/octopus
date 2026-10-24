import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'

import type { RunTargetLockReason } from '@/components/run/run-panel'
import type { NavigationTab } from '@/lib/utils/app-navigation'
import { useRightSidebar } from '../use-right-sidebar'

type SidebarFixtureProps = { lockReason: RunTargetLockReason | null; activeTab?: NavigationTab; canvasAvailable?: boolean }

function useSidebarFixture({ lockReason, activeTab = 'run', canvasAvailable = false }: SidebarFixtureProps) {
  const [runInspectorOpen, setRunInspectorOpen] = useState(true)
  const [createInspectorOpen, setCreateInspectorOpen] = useState(true)
  const headerRef = useRef<HTMLElement>(null)
  return useRightSidebar({
    activeTab, runWorkspaceView: 'session', runInspectorOpen, createInspectorOpen,
    runTargetLockReason: lockReason, setRunInspectorOpen, setCreateInspectorOpen, headerRef,
    ...(canvasAvailable ? { workspaceSidebar: { open: runInspectorOpen, onOpenChange: setRunInspectorOpen } } : {}),
  })
}

describe('Run session sidebar locks', () => {
  it.each<{ lockReason: RunTargetLockReason; label: string }>([
    { lockReason: 'scheduled-research', label: 'Scheduled research in progress' },
    { lockReason: 'team-history', label: 'Team is fixed for this session' },
  ])('explains why the $lockReason sidebar is unavailable', ({ lockReason, label }) => {
    const { result } = renderHook(() => useSidebarFixture({ lockReason }))
    expect(result.current.rightSidebarDisabled).toBe(true)
    expect(result.current.rightSidebarLabel).toBe(label)
  })

  it('closes an open sidebar and refuses toggles and direct reopen requests', () => {
    const initialProps: SidebarFixtureProps = { lockReason: null }
    const { result, rerender } = renderHook(useSidebarFixture, { initialProps })
    expect(result.current.rightSidebarOpen).toBe(false)

    rerender({ lockReason: 'scheduled-research' })
    expect(result.current.rightSidebarOpen).toBe(false)
    expect(result.current.rightSidebarDisabled).toBe(true)
    act(() => result.current.handleRightSidebarToggle())
    act(() => result.current.handleRightSidebarOpenChange(true))
    expect(result.current.rightSidebarOpen).toBe(false)
  })

  it.each<RunTargetLockReason>(['scheduled-research', 'team-history'])('keeps Run on the left after a %s closure', (lockReason) => {
    const initialProps: SidebarFixtureProps = { lockReason: null }
    const { result, rerender } = renderHook(useSidebarFixture, { initialProps })
    rerender({ lockReason })
    act(() => result.current.handleRightSidebarOpenChange(false))
    rerender({ lockReason: null })
    expect(result.current.rightSidebarOpen).toBe(false)
    expect(result.current.rightSidebarDisabled).toBe(true)
  })

  it('keeps Create details available while a scheduled Run session is selected', () => {
    const { result } = renderHook(() => useSidebarFixture({ lockReason: 'scheduled-research', activeTab: 'create' }))
    expect(result.current.rightSidebarOpen).toBe(true)
    expect(result.current.rightSidebarDisabled).toBe(false)
    act(() => result.current.handleRightSidebarToggle())
    expect(result.current.rightSidebarOpen).toBe(false)
  })

  it('records the user closing an available panel', () => {
    const { result } = renderHook(() => useSidebarFixture({ lockReason: null }))
    act(() => result.current.handleRightSidebarOpenChange(false))
    expect(result.current.rightSidebarOpen).toBe(false)
  })
})


it('opens Canvas in the existing Run sidebar and lets the existing title-bar control hide and show it', () => {
  const { result } = renderHook(() => useSidebarFixture({ lockReason: null, canvasAvailable: true }))
  expect(result.current.rightSidebarAvailable).toBe(true)
  expect(result.current.rightSidebarOpen).toBe(true)
  expect(result.current.rightSidebarDisabled).toBe(false)
  act(() => result.current.handleRightSidebarToggle())
  expect(result.current.rightSidebarOpen).toBe(false)
  act(() => result.current.handleRightSidebarToggle())
  expect(result.current.rightSidebarOpen).toBe(true)
})

it.each<RunTargetLockReason>(['scheduled-research', 'team-history'])('keeps the document sidebar available when %s locks chat target selection', (lockReason) => {
  const { result } = renderHook(() => useSidebarFixture({ lockReason, canvasAvailable: true }))
  expect(result.current.rightSidebarLabel).toBe('Hide inspector')
  expect(result.current.rightSidebarDisabled).toBe(false)
  act(() => result.current.handleRightSidebarToggle())
  expect(result.current.rightSidebarLabel).toBe('Show inspector')
  expect(result.current.rightSidebarOpen).toBe(false)
})
