import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  MailboxIngestor,
  IndexJobRunner,
  getMailboxDb,
  resetMailboxDbForTests,
  buildIndexQuery,
  filterSplitThreads,
} from '@gi/mailbox';
import { contentFingerprint, hashBody } from '@gi/shared';

describe('IndexedDB mailbox', () => {
  beforeEach(() => {
    resetMailboxDbForTests();
  });

  it('dedupes unchanged fingerprints', async () => {
    const db = getMailboxDb('test_mb_' + Math.random());
    const ingestor = new MailboxIngestor(db, 'acct');
    const thread = {
      threadId: 't1',
      subject: 'Hello',
      participants: [{ email: 'a@b.com' }],
      latestSender: { email: 'a@b.com' },
      latestTimestamp: '2026-01-01T00:00:00Z',
      messageCount: 1,
      snippet: 'Hi there',
      route: 'inbox',
      messages: [
        {
          messageId: 'm1',
          threadId: 't1',
          sender: { email: 'a@b.com' },
          recipients: [{ email: 'me@x.com' }],
          cc: [],
          timestamp: '2026-01-01T00:00:00Z',
          bodyText: 'Hi there',
          attachmentsMetadata: [],
        },
      ],
    };
    const first = await ingestor.ingestThread(thread);
    expect(first.changed).toBe(true);
    const second = await ingestor.ingestThread(thread);
    expect(second.changed).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('persists and resumes index checkpoint', async () => {
    const db = getMailboxDb('test_cp_' + Math.random());
    const ingestor = new MailboxIngestor(db);
    await ingestor.saveCheckpoint({
      mode: '30d',
      processedThreadIds: ['a', 'b'],
      status: 'paused',
      startedAt: 1,
      updatedAt: 2,
      cursor: 'c1',
    });
    const cp = await ingestor.loadCheckpoint();
    expect(cp?.status).toBe('paused');
    expect(cp?.processedThreadIds).toEqual(['a', 'b']);
  });

  it('builds index queries', () => {
    expect(buildIndexQuery('7d')).toBe('newer_than:7d');
    expect(buildIndexQuery('sent_sample')).toMatch(/in:sent/);
    expect(buildIndexQuery('custom', 'from:me')).toBe('from:me');
  });

  it('fingerprint helper matches ingest', async () => {
    const bodyHash = await hashBody('Hi there');
    const fp = await contentFingerprint({
      gmailThreadId: 't1',
      latestMessageId: 'm1',
      latestTimestamp: '2026-01-01T00:00:00Z',
      normalizedBodyHash: bodyHash,
    });
    expect(fp).toHaveLength(64);
  });

  it('IndexJobRunner stops when a page yields no new threads', async () => {
    const db = getMailboxDb('test_idx_' + Math.random());
    const ingestor = new MailboxIngestor(db);
    let calls = 0;
    const runner = new IndexJobRunner(ingestor, async () => {
      calls += 1;
      // Same thread every page — runner must terminate instead of looping forever
      return {
        threads: [
          {
            threadId: 'dup',
            subject: 'Dup',
            participants: [{ email: 'a@b.com' }],
            latestSender: { email: 'a@b.com' },
            latestTimestamp: '2026-01-01T00:00:00Z',
            messageCount: 1,
            snippet: 'x',
            route: 'search',
            messages: [
              {
                messageId: 'dup-m',
                threadId: 'dup',
                sender: { email: 'a@b.com' },
                recipients: [],
                cc: [],
                timestamp: '2026-01-01T00:00:00Z',
                bodyText: 'x',
                attachmentsMetadata: [],
              },
            ],
          },
        ],
        nextCursor: String(calls),
      };
    });
    const cp = await runner.run({ mode: '7d', paceMs: 0 });
    expect(cp.status).toBe('completed');
    expect(calls).toBeLessThanOrEqual(3);
    expect(await db.threads.count()).toBe(1);
  });
});

describe('split inbox', () => {
  it('returns only the requested local category', () => {
    const threads = [
      { threadId: 'a', classification: 'RESPOND' as const, priority: 'HIGH' as const },
      { threadId: 'b', classification: 'WAITING' as const, priority: 'NORMAL' as const },
      { threadId: 'c', classification: 'FYI' as const, priority: 'LOW' as const },
    ];
    expect(filterSplitThreads(threads, 'RESPOND').map((thread) => thread.threadId)).toEqual(['a']);
    expect(filterSplitThreads(threads, 'WAITING').map((thread) => thread.threadId)).toEqual(['b']);
    expect(filterSplitThreads(threads, 'FYI').map((thread) => thread.threadId)).toEqual(['c']);
    expect(filterSplitThreads(threads, 'NOTIFICATIONS')).toEqual([]);
    expect(filterSplitThreads(threads, 'PRIORITY').map((thread) => thread.threadId)).toEqual(['a']);
    expect(filterSplitThreads(threads, 'FOLLOW_UPS', ['c']).map((thread) => thread.threadId).sort()).toEqual(['b', 'c']);
  });
});

describe('stable fingerprints', () => {
  it('keeps a ROW_STUB stable when no timestamp exists', async () => {
    const db = getMailboxDb('test_stub_' + Math.random());
    const ingestor = new MailboxIngestor(db);
    const stub = {
      threadId: 'stub',
      subject: 'Hello',
      participants: [{ email: 'a@b.com' }],
      latestSender: { email: 'a@b.com' },
      messageCount: 1,
      snippet: 'Preview text',
      route: 'inbox',
      messages: [],
      quality: 'ROW_STUB' as const,
      source: 'dom' as const,
    };
    const first = await ingestor.ingestThread(stub);
    const second = await ingestor.ingestThread({ ...stub });
    expect(second.changed).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
    const stored = await db.threads.get('stub');
    expect(stored?.latestTimestamp).toBe('');
    expect(await db.messages.count()).toBe(0);
  });

  it('upgrades a stub to a complete thread and ignores a later stub', async () => {
    const db = getMailboxDb('test_up_' + Math.random());
    const ingestor = new MailboxIngestor(db);
    const stub = {
      threadId: 't',
      subject: 'Hello',
      participants: [{ email: 'a@b.com' }],
      latestSender: { email: 'a@b.com' },
      messageCount: 1,
      snippet: 'Preview',
      route: 'inbox',
      messages: [],
      quality: 'ROW_STUB' as const,
    };
    await ingestor.ingestThread(stub);
    const message = {
      messageId: 'm1',
      threadId: 't',
      sender: { email: 'a@b.com' },
      recipients: [],
      cc: [],
      bodyText: 'Full message',
      attachmentsMetadata: [],
    };
    const upgraded = await ingestor.ingestThread({
      ...stub,
      quality: 'THREAD_COMPLETE',
      messages: [message],
    });
    expect(upgraded.changed).toBe(true);
    expect(upgraded.quality).toBe('THREAD_COMPLETE');
    const again = await ingestor.ingestThread({ ...stub, quality: 'THREAD_COMPLETE', messages: [message] });
    expect(again.changed).toBe(false);
    const downgrade = await ingestor.ingestThread(stub);
    expect(downgrade.changed).toBe(false);
    expect(downgrade.quality).toBe('THREAD_COMPLETE');
    const snippet = await ingestor.ingestThread({ ...stub, threadId: 'other', snippet: 'Changed preview' });
    const snippet2 = await ingestor.ingestThread({ ...stub, threadId: 'other', snippet: 'Changed again' });
    expect(snippet2.fingerprint).not.toBe(snippet.fingerprint);
    const added = await ingestor.ingestThread({
      ...stub,
      quality: 'THREAD_COMPLETE',
      messages: [message, { ...message, messageId: 'm2', bodyText: 'Second message' }],
    });
    expect(added.changed).toBe(true);
    expect(added.fingerprint).not.toBe(upgraded.fingerprint);
  });
});
