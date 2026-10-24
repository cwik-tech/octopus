import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

import { ResourcePackageExportDialog } from '@/components/library/resource-package-export-dialog';

it('shows the selected export format label before opening the menu', () => {
  render(<ResourcePackageExportDialog kind="team" id="board-team" onClose={() => {}} />);

  expect(screen.getByLabelText('ZIP format')).toHaveTextContent('Octopus package');
});

it('lets the user turn Octopus export history on and off with a switch', async () => {
  const user = userEvent.setup();
  render(<ResourcePackageExportDialog kind="team" id="board-team" onClose={() => {}} />);
  const history = screen.getByRole('switch', { name: 'Include history' });

  expect(history).not.toBeChecked();
  await user.click(history);
  expect(history).toBeChecked();
  await user.click(history);
  expect(history).not.toBeChecked();
});

it('keeps history off for a standard skill export', async () => {
  const user = userEvent.setup();
  render(<ResourcePackageExportDialog kind="skill" id="planning" onClose={() => {}} />);

  expect(screen.getByRole('switch', { name: 'Include history' })).toHaveAttribute('aria-disabled', 'true');
  await user.click(screen.getByRole('switch', { name: 'Include history' }));
  expect(screen.getByRole('switch', { name: 'Include history' })).not.toBeChecked();
});
