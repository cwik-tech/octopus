import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import WorkflowGeneratorChat from '@/components/create/workflow-generator-chat';
import { StreamingReplyMessage } from '@/components/shared/streaming-reply-message';

describe('chat message reading', () => {
  it('offers Maximize only for assistant messages in Create chat', async () => {
    const user = userEvent.setup();
    render(
      <WorkflowGeneratorChat
        history={[
          { role: 'user', text: 'Design a tutorial reviewer.' },
          { role: 'assistant', text: 'Use the teaching specialist.' },
        ]}
        submitting={false}
        error={null}
        onSubmit={() => {}}
        title="Agent Architect"
      />,
    );
    const buttons = screen.getAllByRole('button', { name: 'Maximize message' });
    expect(buttons).toHaveLength(1);
    const [assistantButton] = buttons;
    if (!assistantButton) throw new Error('The assistant message needs a Maximize button');

    await user.click(assistantButton);
    expect(await screen.findByRole('dialog', { name: 'Agent Architect' }))
      .toHaveTextContent('Use the teaching specialist.');
  });

  it('keeps the maximized reply current while new text arrives', async () => {
    const user = userEvent.setup();
    const reply = { replyId: 'specialist:0', text: 'First finding.', lost: false, truncated: false };
    const { rerender } = render(
      <StreamingReplyMessage reply={reply} partialView={false} speakerLabel="Specialist" />,
    );
    await user.click(screen.getByRole('button', { name: 'Maximize message' }));
    const dialog = await screen.findByRole('dialog', { name: 'Specialist' });

    rerender(
      <StreamingReplyMessage
        reply={{ ...reply, text: 'First finding. Second finding.' }}
        partialView={false}
        speakerLabel="Specialist"
      />,
    );

    expect(dialog).toHaveTextContent('First finding. Second finding.');
  });
});
