import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop } from './index.js';
import { AIJobQueue, type AIProvider } from '@gi/ai';
import { getMailboxDb, resetMailboxDbForTests } from '@gi/mailbox';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@gi/shared';

describe('manual classification and drafts', () => {
  beforeEach(() => resetMailboxDbForTests());

  it('does not let AI replace an explicit category, and does not insert a draft unless asked', async () => {
    const db = getMailboxDb('agent_' + Math.random());
    await db.threads.put({
      threadId: 't1',
      accountId: 'default',
      subject: 'Hello',
      participants: [{ email: 'a@b.com' }],
      latestTimestamp: '',
      messageCount: 1,
      snippet: 'Can you reply?',
      route: 'inbox',
      lastIndexedAt: 1,
      contentFingerprint: 'fp1',
      archivedLocally: false,
      requiresResponse: false,
      awaitingResponse: false,
      virtualLabels: [],
    });
    await db.thread_overrides.put({ threadId: 't1', category: 'RESPOND', createdAt: 1 });
    const inserted: string[] = [];
    const ai = {
      classifyEmail: async () => ({
        result: {
          category: 'NEWS' as const,
          confidence: 0.99,
          priority: 'LOW' as const,
          needsReply: false,
          waitingOnReply: false,
          archiveRecommendation: true,
          reason: 'model',
          deadline: null,
        },
      }),
      draftReply: async () => ({ result: { mode: 'direct' as const, body: 'Thursday works.', placeholders: [] } }),
      summarizeThread: async () => ({
        result: {
          oneLine: 'Asked about Thursday.',
          keyPoints: [],
          decisions: [],
          unansweredQuestions: [],
          commitments: [],
          dates: [],
          actionItems: [],
        },
      }),
    } as unknown as AIProvider;
    const settings: ExtensionSettings = {
      ...DEFAULT_SETTINGS,
      aiMode: 'remote',
      autoClassify: true,
      autoSummarize: true,
      autoDraft: true,
      autoInsertDraft: false,
      autoReminders: false,
      autoArchive: false,
    };
    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => settings,
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async (_threadId, body) => {
        inserted.push(body);
        return { success: true };
      },
      log: async () => 'log',
    });
    await agent.onNewMessage({
      threadId: 't1',
      fingerprint: 'fp1',
      subject: 'Hello',
      snippet: 'Can you reply?',
      bodyText: 'Can you meet Thursday?',
      latestSenderEmail: 'a@b.com',
      direction: 'inbound',
      quality: 'THREAD_COMPLETE',
      messages: [{ sender: 'a@b.com', bodyText: 'Can you meet Thursday?', timestamp: '' }],
    });
    expect((await db.thread_classifications.get('t1'))?.category).toBe('RESPOND');
    expect((await db.thread_classifications.get('t1'))?.source).toBe('override');
    expect(inserted).toEqual([]);
    expect((await db.draft_suggestions.toArray())[0]?.suggestion.body).toMatch(/Thursday/);
  });

  it('summarizes an opened email even when nobody needs a reply', async () => {
    const db = getMailboxDb('agent_' + Math.random());
    await db.threads.put({
      threadId: 't2',
      accountId: 'default',
      subject: 'Receipt',
      participants: [{ email: 'notifications@shop.test' }],
      latestTimestamp: '',
      messageCount: 1,
      snippet: 'Your order shipped',
      route: 'inbox',
      lastIndexedAt: 1,
      contentFingerprint: 'fp2',
      archivedLocally: false,
      requiresResponse: false,
      awaitingResponse: false,
      virtualLabels: [],
    });
    const ai = {
      classifyEmail: async () => {
        throw new Error('classify should not be required');
      },
      summarizeThread: async () => ({
        result: {
          oneLine: 'The order shipped.',
          keyPoints: ['Tracking is included'],
          decisions: [],
          unansweredQuestions: [],
          commitments: [],
          dates: [],
          actionItems: [],
        },
      }),
      draftReply: async () => ({ result: { mode: 'direct' as const, body: '', placeholders: [] } }),
    } as unknown as AIProvider;
    const agent = new AgentLoop({
      db,
      ai,
      queue: new AIJobQueue(),
      settings: () => ({ ...DEFAULT_SETTINGS, aiMode: 'remote', autoSummarize: true, autoDraft: false, autoReminders: false, autoArchive: false }),
      archiveViaGmail: async () => ({ success: false }),
      insertDraftViaGmail: async () => ({ success: true }),
      log: async () => 'log',
    });
    await agent.onNewMessage({
      threadId: 't2',
      fingerprint: 'fp2',
      subject: 'Receipt',
      snippet: 'Your order shipped',
      bodyText: 'Your order shipped',
      latestSenderEmail: 'notifications@shop.test',
      direction: 'inbound',
      isNoreply: true,
      quality: 'THREAD_COMPLETE',
      messages: [{ sender: 'notifications@shop.test', bodyText: 'Your order shipped', timestamp: '' }],
    });
    expect((await db.thread_summaries.get('t2'))?.summary.oneLine).toBe('The order shipped.');
  });

  it('summarizes the open message when the model fails', async () => {
    const db = getMailboxDb('agent_' + Math.random());
    const ai = {
      summarizeThread: async () => {
        throw new Error('ChatGPT rejected the request');
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
    const result = await agent.requestSummary({
      threadId: 't3',
      fingerprint: 'fp3',
      subject: '50% off this weekend',
      messages: [{
        sender: 'deals@shop.test',
        bodyText: 'Our weekend sale starts Friday and ends Sunday. Use code FALL.',
        timestamp: '',
      }],
    });
    expect(result.ok).toBe(true);
    expect(result.oneLine).toMatch(/weekend sale starts Friday/i);
    expect((await db.thread_summaries.get('t3'))?.source).toBe('message');
    const again = await agent.requestSummary({
      threadId: 't3',
      fingerprint: 'fp3',
      subject: '50% off this weekend',
      messages: [{
        sender: 'deals@shop.test',
        bodyText: 'Our weekend sale starts Friday and ends Sunday. Use code FALL.',
        timestamp: '',
      }],
    });
    expect(again.oneLine).toMatch(/weekend sale starts Friday/i);
  });
});
