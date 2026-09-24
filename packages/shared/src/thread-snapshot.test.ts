import { describe, expect, it } from 'vitest';
import {
  buildThreadSnapshot,
  normalizeSnapshotMessageId,
} from './thread-snapshot.js';

describe('ThreadSnapshot building and merging', () => {
  it('does not drop a short new page reply even when old stored message is 5,000 chars', async () => {
    const threadId = 'thread-123';
    const oldLongBody = 'A'.repeat(5000);
    const newShortReply = 'Sounds good, thanks!';

    const storedMessages = [
      {
        messageId: 'msg-old',
        sender: 'alice@example.com',
        recipients: ['me@example.com'],
        timestamp: '2026-09-20T10:00:00Z',
        bodyText: oldLongBody,
        loaded: true,
      },
    ];

    const pageMessages = [
      {
        messageId: 'msg-old',
        sender: 'alice@example.com',
        recipients: ['me@example.com'],
        timestamp: '2026-09-20T10:00:00Z',
        bodyText: oldLongBody,
        loaded: true,
      },
      {
        messageId: 'msg-new',
        sender: 'bob@example.com',
        recipients: ['alice@example.com', 'me@example.com'],
        timestamp: '2026-09-20T11:00:00Z',
        bodyText: newShortReply,
        loaded: true,
      },
    ];

    const snapshot = await buildThreadSnapshot({
      threadId,
      subject: 'Project Update',
      pageMessages,
      storedMessages,
    });

    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0].messageId).toBe('msg-old');
    expect(snapshot.messages[0].bodyText).toBe(oldLongBody);
    expect(snapshot.messages[1].messageId).toBe('msg-new');
    expect(snapshot.messages[1].bodyText).toBe(newShortReply);
  });

  it('deduplicates duplicate message IDs across stored and page adapters', async () => {
    const threadId = 'thread-dup';
    const storedMessages = [
      {
        messageId: 'msg-1',
        sender: 'carol@example.com',
        recipients: ['me@example.com'],
        timestamp: '2026-09-21T09:00:00Z',
        bodyText: 'First message stored',
        loaded: true,
      },
      {
        messageId: 'msg-2',
        sender: 'me@example.com',
        recipients: ['carol@example.com'],
        timestamp: '2026-09-21T09:30:00Z',
        bodyText: 'Second message stored (old draft)',
        loaded: true,
      },
    ];

    // Page has msg-1 (same id) with updated content and msg-2
    const pageMessages = [
      {
        messageId: 'msg-1',
        sender: 'carol@example.com',
        recipients: ['me@example.com'],
        timestamp: '2026-09-21T09:00:00Z',
        bodyText: 'First message page content wins',
        loaded: true,
      },
      {
        messageId: 'msg-2',
        sender: 'me@example.com',
        recipients: ['carol@example.com'],
        timestamp: '2026-09-21T09:30:00Z',
        bodyText: 'Second message page content wins',
        loaded: true,
      },
    ];

    const snapshot = await buildThreadSnapshot({
      threadId,
      subject: 'Review',
      pageMessages,
      storedMessages,
    });

    // Exactly 2 messages, no duplicates
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0].messageId).toBe('msg-1');
    expect(snapshot.messages[0].bodyText).toBe('First message page content wins');
    expect(snapshot.messages[1].messageId).toBe('msg-2');
    expect(snapshot.messages[1].bodyText).toBe('Second message page content wins');
  });

  it('supports unloaded InboxSDK messages and updates fingerprint when loaded later', async () => {
    const threadId = 'thread-inboxsdk';

    // Initial state: message view is unloaded
    const unloadedPageMessages = [
      {
        messageId: 'msg-unloaded',
        sender: 'boss@example.com',
        recipients: ['me@example.com'],
        timestamp: '2026-09-22T14:00:00Z',
        bodyText: '',
        loaded: false,
      },
    ];

    const snapshotUnloaded = await buildThreadSnapshot({
      threadId,
      subject: 'Urgent',
      pageMessages: unloadedPageMessages,
    });

    expect(snapshotUnloaded.messages).toHaveLength(1);
    expect(snapshotUnloaded.messages[0].loaded).toBe(false);
    expect(snapshotUnloaded.messages[0].bodyText).toBe('');
    const initialFingerprint = snapshotUnloaded.fingerprint;
    expect(initialFingerprint).toBeTruthy();

    // Stored message can fill body for unloaded page message
    const storedMessages = [
      {
        messageId: 'msg-unloaded',
        sender: 'boss@example.com',
        recipients: ['me@example.com'],
        timestamp: '2026-09-22T14:00:00Z',
        bodyText: 'Cached body from previous sync',
        loaded: true,
      },
    ];

    const snapshotWithFallback = await buildThreadSnapshot({
      threadId,
      subject: 'Urgent',
      pageMessages: unloadedPageMessages,
      storedMessages,
    });

    expect(snapshotWithFallback.messages[0].loaded).toBe(true);
    expect(snapshotWithFallback.messages[0].bodyText).toBe('Cached body from previous sync');
    expect(snapshotWithFallback.fingerprint).not.toBe(initialFingerprint);

    // Later: message view loads real text in page
    const loadedPageMessages = [
      {
        messageId: 'msg-unloaded',
        sender: 'boss@example.com',
        recipients: ['me@example.com'],
        timestamp: '2026-09-22T14:00:00Z',
        bodyText: 'Real full email body now visible in Gmail DOM',
        loaded: true,
      },
    ];

    const snapshotLoaded = await buildThreadSnapshot({
      threadId,
      subject: 'Urgent',
      pageMessages: loadedPageMessages,
      storedMessages,
    });

    expect(snapshotLoaded.messages[0].loaded).toBe(true);
    expect(snapshotLoaded.messages[0].bodyText).toBe('Real full email body now visible in Gmail DOM');
    expect(snapshotLoaded.fingerprint).not.toBe(initialFingerprint);
    expect(snapshotLoaded.fingerprint).not.toBe(snapshotWithFallback.fingerprint);
  });

  it('normalizes message ID prefixes from InboxSDK and Gmail', () => {
    expect(normalizeSnapshotMessageId('msg-a:12345', 0, 't1')).toBe('12345');
    expect(normalizeSnapshotMessageId('msg-f:67890', 1, 't1')).toBe('67890');
    expect(normalizeSnapshotMessageId('#thread-f:abc', 2, 't1')).toBe('abc');
    expect(normalizeSnapshotMessageId(undefined, 3, 't1')).toBe('t1-msg-3');
  });
});
