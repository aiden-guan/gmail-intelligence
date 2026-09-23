/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { applyCategoryChip } from './chips';
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
    root.unmount();
  });
});
