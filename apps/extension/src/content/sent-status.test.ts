/**
 * @vitest-environment jsdom
 */
import type { TrackedEmailSummary } from '@gi/tracking';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paintRows } from './sent-status';

const opened: TrackedEmailSummary = {
  trackingId: 'trk_open',
  subject: 'Hello',
  sender: 'me@example.com',
  recipients: ['aiden@example.com'],
  gmailThreadId: 'thread-1',
  gmailMessageId: 'msg-1',
  sentAt: '2026-09-22T15:00:00.000Z',
  firstOpenedAt: '2026-09-22T15:00:20.000Z',
  lastOpenedAt: '2026-09-22T15:00:20.000Z',
  openCount: 2,
  clickCount: 0,
  notifyIfNoReply: false,
};

const waiting: TrackedEmailSummary = {
  ...opened,
  trackingId: 'trk_wait',
  gmailThreadId: 'thread-2',
  recipients: ['sam@example.com'],
  subject: 'Follow up',
  firstOpenedAt: null,
  lastOpenedAt: null,
  openCount: 0,
};

beforeEach(() => {
  document.body.innerHTML = '';
  document.getElementById('gi-track-style')?.remove();
  document.querySelector('[data-gi-ui="track-card"]')?.remove();
});

function row(threadId: string, email: string, subject: string): void {
  document.body.innerHTML += `
    <table><tbody>
      <tr class="zA" data-legacy-thread-id="${threadId}">
        <td class="yX"><div class="yW"><span email="${email}">${email}</span></div></td>
        <td><span class="bog">${subject}</span></td>
      </tr>
    </tbody></table>
  `;
}

describe('sent mail open status', () => {
  it('shows a green opened check and a gray not-opened check', () => {
    row('thread-1', 'aiden@example.com', 'Hello');
    row('thread-2', 'sam@example.com', 'Follow up');
    paintRows(document, [opened, waiting], 'https://track.example', () => undefined);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.gi-track-btn')];
    expect(buttons.map((button) => button.dataset.state)).toEqual(['opened', 'pending']);
    expect(buttons[0].getAttribute('aria-label')).toMatch(/aiden@example.com opened your email/);
    expect(buttons[1].getAttribute('aria-label')).toMatch(/sam@example.com has not opened/);
    expect(document.querySelector('[data-legacy-thread-id="thread-1"]')?.getAttribute('data-gi-tracked')).toBe('opened');
  });

  it('opens a status card with the open count and a no-reply switch', () => {
    row('thread-1', 'aiden@example.com', 'Hello');
    const onNotify = vi.fn();
    paintRows(document, [opened], 'https://track.example', onNotify);
    const button = document.querySelector<HTMLButtonElement>('.gi-track-btn');
    button?.click();
    const card = document.querySelector('[data-gi-ui="track-card"]');
    expect(card?.textContent).toContain('aiden@example.com');
    expect(card?.textContent).toContain('opened your email');
    expect(card?.textContent).toContain('First opened less than a minute after you sent.');
    expect(card?.textContent).toContain('Opened 2 times');
    expect(card?.textContent).toContain('Notify me if there is no reply');
    card?.querySelector<HTMLButtonElement>('[role="switch"]')?.click();
    expect(onNotify).toHaveBeenCalledWith('trk_open', true);
    card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[data-gi-ui="track-card"]')).toBeNull();
  });

  it('leaves untracked rows alone', () => {
    row('thread-9', 'other@example.com', 'Something else');
    paintRows(document, [opened], 'https://track.example', () => undefined);
    expect(document.querySelector('.gi-track-btn')).toBeNull();
  });

  it('warns when the tracker cannot be reached by Gmail', () => {
    row('thread-2', 'sam@example.com', 'Follow up');
    paintRows(document, [waiting], 'http://127.0.0.1:8787', () => undefined);
    document.querySelector<HTMLButtonElement>('.gi-track-btn')?.click();
    expect(document.querySelector('[data-gi-ui="track-card"]')?.textContent).toMatch(/cannot reach this computer/);
  });
});
