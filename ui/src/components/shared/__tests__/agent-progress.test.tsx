import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentProgress } from '../agent-progress';

afterEach(() => vi.useRealTimers());

it('shows stale activity and expands the observed history', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  render(<AgentProgress speaker="Analyst" snapshot={{ revision: 1, startedAt: 1000, updatedAt: 10_000, current: { kind: 'observed', phase: 'thinking' }, history: [{ at: 1000, update: { kind: 'observed', phase: 'thinking' } }] }} />);
  const trigger = screen.getByRole('button', { name: 'Agent progress: Thinking' });
  fireEvent.click(trigger);
  expect(screen.getByText('Recent activity')).toBeVisible();
  await act(() => vi.advanceTimersByTime(31_000));
  expect(screen.getByText('Last activity 00:31 ago')).toBeVisible();
});

it('labels an agent-reported checklist and preserves the observed waiting state', () => {
  vi.useFakeTimers();
  vi.setSystemTime(2000);
  render(<AgentProgress speaker="Analyst" snapshot={{ revision: 2, startedAt: 1000, updatedAt: 2000,
    current: { kind: 'observed', phase: 'waiting' }, history: [],
    reported: { at: 1500, summary: 'Updating calendar interactions', tasks: [{ id: 'calendar', label: 'Calendar interactions', status: 'active' }] },
  }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Agent progress: Updating calendar interactions' }));
  expect(screen.getByText('Agent-reported tasks')).toBeVisible();
  expect(screen.getByRole('list', { name: 'Agent-reported tasks' })).toHaveTextContent('Calendar interactions · In progress');
  expect(screen.getByText('Waiting for provider')).toBeVisible();
});
