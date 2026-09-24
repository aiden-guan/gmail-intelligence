/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { applyCategoryChip, rowsForThread } from './chips';
import { isVisibleCommand, VISIBLE_COMMANDS } from './commands';
import { ThreadIntelCard } from './thread-panel';

describe('commands', () => {
  it('only exposes commands that have real handlers', () => {
    expect(VISIBLE_COMMANDS.map((command) => command.id)).toEqual([
      'ask',
      'summarize',
      'draft',
      'remind',
      'archive',
      'settings',
      'mark_respond',
      'mark_waiting',
      'mark_fyi',
    ]);
    for (const command of VISIBLE_COMMANDS) expect(isVisibleCommand(command.id)).toBe(true);
    expect(isVisibleCommand('index')).toBe(false);
    expect(isVisibleCommand('always_archive')).toBe(false);
  });
});

describe('reactive intelligence', () => {
  it('updates a row chip when classification arrives', () => {
    document.body.innerHTML = '<table><tbody><tr class="zA" data-legacy-thread-id="t1"><td class="y6"><span class="bog">Hello</span></td></tr></tbody></table>';
    const row = document.querySelector('tr') as HTMLElement;
    applyCategoryChip(row, 'FYI', false);
    expect(row.textContent).toContain('FYI');
    applyCategoryChip(row, 'RESPOND', true);
    expect(row.textContent).toContain('Respond');
    expect(row.querySelector('.gi-cat-chip')?.getAttribute('data-manual')).toBe('1');
  });

  it('finds a row when the thread id is on the subject', () => {
    document.body.innerHTML = `
      <div role="list">
        <div role="listitem">
          <span data-legacy-thread-id="t9">Hello</span>
        </div>
      </div>
    `;
    expect(rowsForThread('t9')).toHaveLength(1);
  });

  it('shows the summary and draft button when they are ready', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ThreadIntelCard intel={{ classification: { category: 'FYI' } }} onDraft={() => undefined} onRemind={() => undefined} />);
    });
    expect(host.textContent).toContain('No summary yet.');
    expect(host.textContent).not.toContain('Draft reply');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'RESPOND', needsReply: true },
            summary: { summary: { oneLine: 'Asked about Thursday.' } },
            draft: { suggestion: { body: 'Thursday works.' } },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('Asked about Thursday.');
    expect(host.textContent).toContain('Draft reply');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{ classification: { category: 'FYI' } }}
          pending="Reading this thread…"
          tracking={{
            opened: true,
            markLabel: 'Opened',
            headline: 'aiden@example.com opened your email a minute ago.',
            detail: 'First opened less than a minute after you sent.',
            countLabel: 'Opened once',
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('opened your email');
    expect(host.textContent).toContain('Reading this thread');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'FYI' },
            summary: { summary: { oneLine: 'A short note to Dylan.' } },
          }}
          tracking={{
            opened: true,
            markLabel: 'Opened',
            headline: 'aiden@example.com opened your email a minute ago.',
            detail: 'First opened less than a minute after you sent.',
            countLabel: 'Opened once',
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('A short note to Dylan.');
    expect(host.textContent).toContain('opened your email');
    expect(host.textContent).not.toContain('Reading this thread');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{ classification: { category: 'PROMOTIONS' } }}
          pending="Could not summarize this thread."
          preview="Our weekend sale starts Friday."
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('Our weekend sale starts Friday.');
    expect(host.textContent).not.toContain('Could not summarize');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'PROMOTIONS' },
            summary: {
              summary: {
                oneLine: 'ACA invited you to the Berkeley China Summit with TikTok Recruiting.',
                keyPoints: ['TikTok Recruiting is a partner'],
                dates: ['Friday'],
                actionItems: ['Open the summit details'],
              },
            },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.querySelector('li')?.textContent).toBe('TikTok Recruiting is a partner');
    expect(host.textContent).toContain('Friday');
    const details = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Details');
    expect(details).toBeTruthy();
    await act(async () => {
      details?.click();
    });
    expect(host.textContent).toContain('Next steps');
    expect(host.textContent).toContain('Open the summit details');
    root.unmount();
  });

  it('hides the card to a pill and brings it back', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'RESPOND', needsReply: true },
            summary: { summary: { oneLine: 'Asked about Thursday.', keyPoints: ['Thursday is open'] } },
            draft: { suggestion: { body: 'Thursday works.' } },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    const hide = host.querySelector('[aria-label="Hide intelligence"]') as HTMLButtonElement;
    await act(async () => {
      hide.click();
    });
    expect(host.textContent).not.toContain('Draft reply');
    const show = host.querySelector('[aria-label="Show intelligence"]') as HTMLButtonElement;
    expect(show?.textContent).toContain('Respond');
    await act(async () => {
      show.click();
    });
    expect(host.textContent).toContain('Draft reply');
    expect(host.textContent).toContain('Thursday is open');
    root.unmount();
  });

  it('suppresses open questions and cleans dates for promotional emails', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'PROMOTIONS' },
            summary: {
              summary: {
                oneLine: 'RecWell announced their September programs.',
                dates: ['September', 'Wednesday', 'September 30'],
                unansweredQuestions: ['...', 'OAKBERRY Want a healthy and delicious grub?'],
                actionItems: ['Sign up online'],
              },
            },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });

    // Dates should be cleaned to only 'September 30'
    expect(host.textContent).toContain('September 30');
    const dateElements = host.querySelectorAll('.gi-date');
    expect(dateElements).toHaveLength(1);
    expect(dateElements[0]?.textContent?.trim()).toBe('September 30');

    // Details button should be present for Next steps ('Sign up online')
    const details = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Details');
    expect(details).toBeTruthy();
    await act(async () => {
      details?.click();
    });

    // Open questions must NOT be rendered for promotional emails
    expect(host.textContent).not.toContain('Open questions');
    expect(host.textContent).not.toContain('OAKBERRY');
    expect(host.textContent).not.toContain('...');
    expect(host.textContent).toContain('Next steps');
    expect(host.textContent).toContain('Sign up online');
    root.unmount();
  });
});
