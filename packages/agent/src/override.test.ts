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
});
