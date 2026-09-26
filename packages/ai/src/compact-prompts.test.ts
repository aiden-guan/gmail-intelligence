import { describe, expect, it } from 'vitest';
import { parseCompactSummary } from './compact-prompts.js';
import { createPromptBackedProvider } from './prompt-provider.js';

describe('compact summary parsing', () => {
  it('reads the labeled format', () => {
    expect(
      parseCompactSummary(
        'Summary: Sections resume in Week 6. Students should sign up first.\nPoints: The site is back up.\nDates: Sign up by Sep 25 | Week 6 starts Sep 28\nTo do: Sign up for a slot',
      ),
    ).toEqual({
      oneLine: 'Sections resume in Week 6. Students should sign up first.',
      keyPoints: ['The site is back up'],
      dates: ['Sign up by Sep 25', 'Week 6 starts Sep 28'],
      actionItems: ['Sign up for a slot'],
    });
  });

  it('accepts bullets, bold labels, and "none"', () => {
    expect(
      parseCompactSummary('**Summary:** Your order shipped and arrives Friday.\n**Points:**\n- Tracking is in the app\n- Signature needed\nDates: none\nTo do: none'),
    ).toEqual({
      oneLine: 'Your order shipped and arrives Friday.',
      keyPoints: ['Tracking is in the app', 'Signature needed'],
      dates: [],
      actionItems: [],
    });
  });

  it('uses plain prose as the summary when a model ignores the format', () => {
    expect(parseCompactSummary('Maria wants the Q3 numbers by Thursday. She needs them for the board. Extra.')?.oneLine).toBe(
      'Maria wants the Q3 numbers by Thursday. She needs them for the board.',
    );
    expect(parseCompactSummary('   ')).toBeNull();
    expect(parseCompactSummary('Summary: Rust 2.0 ships async closures for $4.99. More.')?.oneLine).toBe(
      'Rust 2.0 ships async closures for $4.99. More.',
    );
  });
});

describe('compact provider', () => {
  const email = {
    subject: 'Tutoring sections',
    messages: [{ sender: 'Prof. Kim', bodyText: 'The tutoring site is back up. Sections resume Week 6 on Monday 9/28.', timestamp: '' }],
  };

  it('summarizes from plain text without JSON and caps generation length', async () => {
    const calls: Array<{ system: string; maxTokens?: number }> = [];
    const provider = createPromptBackedProvider(
      'local',
      async (system, _user, options) => {
        calls.push({ system, maxTokens: options?.maxTokens });
        return { text: 'Summary: Tutoring is running again from Week 6.\nPoints: none\nDates: Week 6 starts Sep 28\nTo do: none' };
      },
      { summaryStyle: 'compact', repairInvalidJson: false },
    );
    const { result } = await provider.summarizeThread(email);
    expect(result.oneLine).toBe('Tutoring is running again from Week 6.');
    expect(result.dates).toEqual(['Week 6 starts Sep 28']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).not.toMatch(/JSON/);
    expect(calls[0]!.maxTokens).toBeLessThanOrEqual(200);
  });

  it('still accepts a JSON summary from a model that prefers it', async () => {
    const provider = createPromptBackedProvider(
      'local',
      async () => ({ text: '{"oneLine":"Tutoring resumes in Week 6.","keyPoints":[],"dates":[],"actionItems":[]}' }),
      { summaryStyle: 'compact' },
    );
    const { result } = await provider.summarizeThread(email);
    expect(result.oneLine).toBe('Tutoring resumes in Week 6.');
  });

  it('leaves sorting to the heuristic rules without calling the model when asked to', async () => {
    let calls = 0;
    const provider = createPromptBackedProvider('local', async () => {
      calls += 1;
      return { text: 'RESPOND' };
    }, { summaryStyle: 'compact', classifyWithModel: false });
    await expect(
      provider.classifyEmail({ subject: 'Update', snippet: '', bodyText: 'Closed Monday.', latestSender: 'hr@x.com', direction: 'inbound' }),
    ).rejects.toThrow('does not sort mail');
    expect(calls).toBe(0);
  });

  it('rewrites text as plain output', async () => {
    const provider = createPromptBackedProvider('local', async () => ({ text: 'Here is the rewritten text:\nThanks, see you Friday.' }), {
      summaryStyle: 'compact',
    });
    const { result } = await provider.rewriteText({ text: 'thx see u fri', mode: 'improve' });
    expect(result).toBe('Thanks, see you Friday.');
  });
});
