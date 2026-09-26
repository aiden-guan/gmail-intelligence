import { describe, expect, it } from 'vitest';
import { AIJobQueue } from '@gi/ai';
import { detectPlaceholders } from '@gi/shared';

describe('AI cache invalidation', () => {
  it('returns cached result for same fingerprint', async () => {
    const q = new AIJobQueue();
    let calls = 0;
    const a = await q.enqueue('classify', 'fp1', async () => {
      calls += 1;
      return { ok: true };
    });
    const b = await q.enqueue('classify', 'fp1', async () => {
      calls += 1;
      return { ok: false };
    });
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it('recomputes when fingerprint changes', async () => {
    const q = new AIJobQueue();
    let calls = 0;
    await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 1;
    });
    await q.enqueue('summary', 'fp2', async () => {
      calls += 1;
      return 2;
    });
    expect(calls).toBe(2);
  });

  it('recomputes and replaces cache when bypassCache is true', async () => {
    const q = new AIJobQueue();
    let calls = 0;
    const res1 = await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 'first';
    });
    expect(res1).toBe('first');
    expect(calls).toBe(1);

    // Without bypassCache, returns cached 'first'
    const res2 = await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 'second';
    });
    expect(res2).toBe('first');
    expect(calls).toBe(1);

    // With bypassCache, invokes function again and updates cache
    const res3 = await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 'third';
    }, { bypassCache: true });
    expect(res3).toBe('third');
    expect(calls).toBe(2);

    // Subsequent normal call returns 'third'
    const res4 = await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 'fourth';
    });
    expect(res4).toBe('third');
    expect(calls).toBe(2);
  });

  it('aborts signal on timeout and does not write late results to cache', async () => {
    const q = new AIJobQueue();
    let aborted = false;
    let lateFinished = false;

    await expect(
      q.enqueue(
        'classify',
        'fp_timeout',
        async (signal) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
          });
          await new Promise((r) => setTimeout(r, 100));
          lateFinished = true;
          return { ok: true };
        },
        { timeoutMs: 30 },
      ),
    ).rejects.toThrow('timed out');

    expect(aborted).toBe(true);

    // Wait past the late completion
    await new Promise((r) => setTimeout(r, 120));
    expect(lateFinished).toBe(true);

    // Cache must remain empty because the job timed out
    expect(q.getCached('fp_timeout', 'classify')).toBeUndefined();
    expect(q.usageToday.classifications).toBe(0);
  });
});

describe('draft prompt placeholders', () => {
  it('shared detector finds unresolved facts', () => {
    expect(detectPlaceholders('Pay [AMOUNT] via [LINK]')).toEqual(['[AMOUNT]', '[LINK]']);
  });
});

describe('draft suggestion coercion', () => {
  it('accepts raw strings and non-standard JSON keys from smaller models', async () => {
    const { coerceDraftSuggestion, createPromptBackedProvider } = await import('./prompt-provider.js');

    expect(coerceDraftSuggestion('Hi Alice, thanks for the update.')).toEqual({
      mode: 'direct',
      body: 'Hi Alice, thanks for the update.',
      placeholders: [],
    });

    expect(coerceDraftSuggestion({ reply: 'Here is my reply.' })).toEqual({
      mode: 'direct',
      subject: undefined,
      body: 'Here is my reply.',
      placeholders: [],
      confidence: undefined,
    });

    const provider = createPromptBackedProvider('test', async () => ({
      text: 'Thanks for reaching out! Let us meet tomorrow.',
    }));

    const result = await provider.draftReply({
      subject: 'Meeting',
      messages: [{ sender: 'alice@example.com', bodyText: 'Can we meet?', timestamp: 'now' }],
    });

    expect(result.result.body).toBe('Thanks for reaching out! Let us meet tomorrow.');
  });
});

describe('compact on-device drafting', () => {
  const email = {
    subject: 'Lab access',
    messages: [{
      sender: 'Priya Shah <priya@example.com>',
      bodyText: 'Hi, can you confirm whether you still need badge access to the lab next week? I need to submit the list by Thursday.',
      timestamp: 'now',
    }],
  };

  it('sends plain-text prompts with worked examples and ends the user turn with the task', async () => {
    const { createPromptBackedProvider } = await import('./prompt-provider.js');
    const calls: Array<{ system: string; user: string; options?: { examples?: unknown[] } }> = [];
    const provider = createPromptBackedProvider('local', async (system, user, options) => {
      calls.push({ system, user, options });
      return { text: 'Reply: Hi Priya,\n\nYes, I still need lab access next week. Thanks for checking.' };
    }, { summaryStyle: 'compact', repairInvalidJson: false });

    const result = await provider.draftReply({ ...email, voice: undefined as never, kind: 'reply' });

    expect(result.result.body).toBe('Hi Priya,\n\nYes, I still need lab access next week. Thanks for checking.');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).not.toMatch(/JSON/);
    expect(calls[0]!.user).toMatch(/^From: Priya Shah\nSubject: Lab access/);
    expect(calls[0]!.user.trim().endsWith('Write my reply to Priya Shah.')).toBe(true);
    expect(calls[0]!.options?.examples?.length).toBe(2);
  });

  it('retries once when the model summarizes the email, then fails clearly', async () => {
    const { createPromptBackedProvider } = await import('./prompt-provider.js');
    const outputs = [
      'The email is asking whether the recipient still needs badge access to the lab.',
      'Hi Priya, yes please keep me on the list. Thanks!',
    ];
    const provider = createPromptBackedProvider('local', async () => ({ text: outputs.shift()! }), {
      summaryStyle: 'compact',
    });
    const result = await provider.draftReply({ ...email, voice: undefined as never, kind: 'reply' });
    expect(result.result.body).toBe('Hi Priya, yes please keep me on the list. Thanks!');

    const stubborn = createPromptBackedProvider('local', async () => ({
      text: 'Priya is informing the recipient that the sender needs to submit the list by Thursday.',
    }), { summaryStyle: 'compact' });
    await expect(stubborn.draftReply({ ...email, voice: undefined as never, kind: 'reply' })).rejects.toThrow(/summarized/);
  });

  it('flags third-person narration but accepts ordinary replies', async () => {
    const { draftQualityIssue } = await import('./draft-prompt.js');
    expect(draftQualityIssue(email.messages, 'This message informs the reader about new lab access rules.')).toMatch(/summarized/);
    expect(draftQualityIssue(email.messages, 'The sender wants to know if badge access is still needed.')).toMatch(/summarized/);
    expect(draftQualityIssue(email.messages, 'Thanks for your email! Yes, I still need access next week.')).toBeNull();
  });
});

describe('summary thread formatting and coercion', () => {
  it('keeps the compact model on the latest update when an older notice is quoted', async () => {
    const { formatThreadForSummary } = await import('./summary-prompt.js');
    const formatted = formatThreadForSummary({
      subject: 'Tutoring Sections Update for Week 5',
      includeOlder: false,
      messages: [{
        sender: 'instructor@example.com',
        bodyText: 'The website reopened. Sections resume Week 6 on 9/28.\n----------------\nPrevious Announcement: No sections during Week 5.',
      }],
    });
    expect(formatted).toMatch(/Sections resume Week 6/);
    expect(formatted).not.toMatch(/Week 5|Previous Announcement/);
  });

  it('formats thread cleanly with senders, timestamps, and message blocks', async () => {
    const { formatThreadForSummary } = await import('./summary-prompt.js');
    const formatted = formatThreadForSummary({
      subject: 'Bug report: login failure',
      messages: [
        { sender: 'john@example.com', bodyText: 'Login fails on iOS 17.', timestamp: '2026-09-23 10:00' },
        { sender: 'sarah@example.com', bodyText: 'Confirmed, hotfix tomorrow.', timestamp: '2026-09-23 10:15' },
      ],
    });

    expect(formatted).toContain('Subject: Bug report: login failure');
    expect(formatted).toContain('--- Message 1 from john@example.com at 2026-09-23 10:00 ---');
    expect(formatted).toContain('Login fails on iOS 17.');
    expect(formatted).toContain('--- Message 2 from sarah@example.com at 2026-09-23 10:15 ---');
    expect(formatted).toContain('Confirmed, hotfix tomorrow.');
  });

  it('coerceThreadSummary extracts reasoning and sanitizes output', async () => {
    const { coerceThreadSummary } = await import('./prompt-provider.js');
    const coerced = coerceThreadSummary({
      reasoning: 'John found a bug, Sarah confirmed and will deploy a hotfix tomorrow.',
      one_line: 'Sarah verified the login bug reported by John and will patch it tomorrow.',
      key_points: ['Issue affects iOS 17 only.'],
      decisions: ['Deploy patch tomorrow.'],
      questions: ['Want a discount?'], // rhetorical marketing question should be stripped
      commitments: ['Sarah will deploy patch'],
      dates: ['Tomorrow'],
      actions: ['Review patch PR'],
    }) as any;

    expect(coerced.reasoning).toBe('John found a bug, Sarah confirmed and will deploy a hotfix tomorrow.');
    expect(coerced.oneLine).toBe('Sarah verified the login bug reported by John and will patch it tomorrow.');
    expect(coerced.keyPoints).toEqual(['Issue affects iOS 17 only.']);
    expect(coerced.decisions).toEqual(['Deploy patch tomorrow.']);
    expect(coerced.unansweredQuestions).toEqual([]);
    expect(coerced.commitments).toEqual(['Sarah will deploy patch']);
    expect(coerced.dates).toEqual(['Tomorrow']);
    expect(coerced.actionItems).toEqual(['Review patch PR']);
  });
});
