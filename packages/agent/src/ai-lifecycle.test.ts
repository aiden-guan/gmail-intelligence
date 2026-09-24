import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop } from './index.js';
import { AIJobQueue, type AIProvider } from '@gi/ai';
import { getMailboxDb, resetMailboxDbForTests } from '@gi/mailbox';
import { DEFAULT_SETTINGS } from '@gi/shared';

describe('AI job asynchronous lifecycle and deduplication', () => {
  beforeEach(() => {
    resetMailboxDbForTests();
  });

  it('runs long-running summary inference (~18s) asynchronously, returning queued immediately, updating DB and emitting intel events', async () => {
    const db = getMailboxDb('lifecycle_' + Math.random());
    const intelEvents: string[] = [];
    let resolveInference!: (val: unknown) => void;
    const inferencePromise = new Promise((resolve) => {
      resolveInference = resolve;
    });

    const ai = {
      summarizeThread: async () => {
        await inferencePromise;
        return {
          result: {
            reasoning: '',
            oneLine: 'Quarterly financial results reviewed.',
            keyPoints: ['Revenue up 12%'],
            decisions: [],
            unansweredQuestions: [],
            commitments: [],
            dates: [],
            actionItems: [],
          },
        };
      },
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoSummarize: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
      onIntel: (_threadId, kind) => {
        intelEvents.push(kind);
      },
    });

    const threadId = 't_long';
    const fingerprint = 'fp_long';
    const input = {
      threadId,
      fingerprint,
      subject: 'Q3 Results',
      messages: [{ sender: 'cfo@corp.test', bodyText: 'Here are the Q3 results.', timestamp: '' }],
    };

    // 1. Initial request returns queued response immediately without blocking on inference
    const queuedRes = await agent.startSummaryJob(input);
    expect(queuedRes.ok).toBe(true);
    expect(queuedRes.status).toBe('queued');
    expect(queuedRes.jobId).toBeTruthy();

    // Verify inference is still in-flight
    expect(await db.thread_summaries.get(threadId)).toBeUndefined();
    const midJob = await db.ai_jobs.get(queuedRes.jobId);
    expect(['queued', 'running']).toContain(midJob?.status);

    // 2. Resolve the long-running model inference
    resolveInference(true);

    // Wait a tick for background async completion
    await new Promise((r) => setTimeout(r, 50));

    const finalJob = await db.ai_jobs.get(queuedRes.jobId);
    expect(finalJob?.status).toBe('succeeded');
    expect(finalJob?.completedAt).toBeDefined();

    // Verify DB updated with model source and success status
    const summary = await db.thread_summaries.get(threadId);
    expect(summary?.source).toBe('model');
    expect(summary?.aiStatus).toBe('success');
    expect(summary?.summary.oneLine).toBe('Quarterly financial results reviewed.');

    // Verify intel events emitted
    expect(intelEvents).toContain('THREAD_SUMMARY_READY');
    expect(intelEvents).toContain('THREAD_INTELLIGENCE_UPDATED');
  });

  it('runs long-running draft inference asynchronously, updating DB and emitting draft ready event', async () => {
    const db = getMailboxDb('lifecycle_draft_' + Math.random());
    const intelEvents: string[] = [];
    let resolveInference!: (val: unknown) => void;
    const inferencePromise = new Promise((resolve) => {
      resolveInference = resolve;
    });

    const ai = {
      draftReply: async () => {
        await inferencePromise;
        return {
          result: {
            mode: 'direct' as const,
            body: 'I will attend the Q3 review.',
            placeholders: [],
          },
        };
      },
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoDraft: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
      onIntel: (_threadId, kind) => {
        intelEvents.push(kind);
      },
    });

    const threadId = 't_draft';
    const fingerprint = 'fp_draft';
    const input = {
      threadId,
      fingerprint,
      subject: 'Review invite',
      messages: [{ sender: 'lead@corp.test', bodyText: 'Can you attend?', timestamp: '' }],
    };

    const queuedRes = await agent.startDraftJob(input);
    expect(queuedRes.ok).toBe(true);
    expect(queuedRes.status).toBe('queued');

    // While running, draft suggestion is not yet stored
    expect(await db.draft_suggestions.where('threadId').equals(threadId).first()).toBeUndefined();

    // Resolve inference
    resolveInference(true);
    await new Promise((r) => setTimeout(r, 50));

    const savedDraft = await db.draft_suggestions.where('threadId').equals(threadId).first();
    expect(savedDraft?.suggestion.body).toBe('I will attend the Q3 review.');
    expect(savedDraft?.fingerprint).toBe(fingerprint);

    expect(intelEvents).toContain('THREAD_DRAFT_READY');
    expect(intelEvents).toContain('THREAD_INTELLIGENCE_UPDATED');
  });

  it('deduplicates simultaneous requests for the same threadId + fingerprint + job kind', async () => {
    const db = getMailboxDb('lifecycle_dedup_' + Math.random());
    let aiCalls = 0;
    let resolveInference!: (val: unknown) => void;
    const inferencePromise = new Promise((resolve) => {
      resolveInference = resolve;
    });

    const ai = {
      summarizeThread: async () => {
        aiCalls += 1;
        await inferencePromise;
        return {
          result: {
            reasoning: '',
            oneLine: 'Budget approved.',
            keyPoints: [],
            decisions: [],
            unansweredQuestions: [],
            commitments: [],
            dates: [],
            actionItems: [],
          },
        };
      },
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoSummarize: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
    });

    const input = {
      threadId: 't_dedup',
      fingerprint: 'fp_dedup',
      subject: 'Budget',
      messages: [{ sender: 'mgr@corp.test', bodyText: 'Budget is ready.', timestamp: '' }],
    };

    // First request starts inference
    const job1 = await agent.startSummaryJob(input);
    expect(job1.ok).toBe(true);

    // Second request with exact same threadId + fingerprint while job1 is in-flight
    const job2 = await agent.startSummaryJob(input);
    expect(job2.ok).toBe(true);
    expect(job2.jobId).toBe(job1.jobId);

    // Complete inference
    resolveInference(true);
    await new Promise((r) => setTimeout(r, 50));

    // AI model was invoked only ONCE despite two startSummaryJob calls
    expect(aiCalls).toBe(1);
  });

  it('generates a new job when the thread fingerprint changes', async () => {
    const db = getMailboxDb('lifecycle_fp_change_' + Math.random());
    let aiCalls = 0;

    const ai = {
      summarizeThread: async () => {
        aiCalls += 1;
        return {
          result: {
            reasoning: '',
            oneLine: `Summary version ${aiCalls}`,
            keyPoints: [],
            decisions: [],
            unansweredQuestions: [],
            commitments: [],
            dates: [],
            actionItems: [],
          },
        };
      },
    } as unknown as AIProvider;

    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoSummarize: true }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
    });

    const threadId = 't_fp';
    const input1 = {
      threadId,
      fingerprint: 'fp_initial',
      subject: 'Discussion',
      messages: [{ sender: 'p1@corp.test', bodyText: 'Initial message', timestamp: '' }],
    };

    const res1 = await agent.startSummaryJob(input1);
    await new Promise((r) => setTimeout(r, 50));
    expect(aiCalls).toBe(1);

    // Now a new message arrives, changing the fingerprint
    const input2 = {
      threadId,
      fingerprint: 'fp_updated_with_reply',
      subject: 'Discussion',
      messages: [
        { sender: 'p1@corp.test', bodyText: 'Initial message', timestamp: '' },
        { sender: 'p2@corp.test', bodyText: 'Here is my reply', timestamp: '' },
      ],
    };

    const res2 = await agent.startSummaryJob(input2);
    await new Promise((r) => setTimeout(r, 50));
    expect(aiCalls).toBe(2);
    expect(res2.jobId).not.toBe(res1.jobId);
  });
});
