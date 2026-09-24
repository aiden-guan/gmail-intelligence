/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { InboxSdkAdapter, type InboxSdkLike } from './InboxSdkAdapter.js';
import { CompositeGmailAdapter } from './index.js';
import { resolveMessageId, resolveThreadId } from './thread-id.js';
import type { MailboxEvent } from './types.js';

function sdk(handlers: { rows: Array<(row: unknown) => void>; threads: number; compose: number; routes: number }): InboxSdkLike {
  return {
    Router: { handleAllRoutes() { handlers.routes += 1; } },
    Conversations: { registerThreadViewHandler() { handlers.threads += 1; } },
    Compose: { registerComposeViewHandler() { handlers.compose += 1; } },
    Lists: {
      registerThreadRowViewHandler(cb) {
        handlers.rows.push(cb);
      },
    },
  };
}

describe('adapter lifecycle', () => {
  it('starts once and does not register InboxSDK twice', async () => {
    const handlers = { rows: [] as Array<(row: unknown) => void>, threads: 0, compose: 0, routes: 0 };
    const adapter = new CompositeGmailAdapter();
    expect(adapter.bindInboxSdk(sdk(handlers))).toBe(true);
    await adapter.start(() => undefined);
    await adapter.start(() => undefined);
    expect(adapter.getActiveIntegration()).toBe('inboxsdk');
    expect(handlers.rows).toHaveLength(1);
    expect(handlers.threads).toBe(1);
  });

  it('selects DOM only when InboxSDK was not bound before start', async () => {
    const adapter = new CompositeGmailAdapter({ debounceMs: 0 });
    await adapter.start(() => undefined);
    expect(adapter.getActiveIntegration()).toBe('dom');
    expect(adapter.bindInboxSdk(sdk({ rows: [], threads: 0, compose: 0, routes: 0 }))).toBe(false);
    expect(adapter.getActiveIntegration()).toBe('dom');
    await adapter.stop();
  });

  it('resolves async thread ids', async () => {
    expect(await resolveThreadId({ getThreadID: () => 'sync-id' })).toBe('sync-id');
    expect(await resolveThreadId({ getThreadIDAsync: async () => 'async-id' })).toBe('async-id');
    expect(await resolveThreadId({ getThreadID: () => Promise.resolve('promised') })).toBe('promised');
    let syncCalls = 0;
    expect(await resolveThreadId({
      getThreadID: () => {
        syncCalls += 1;
        return 'sync';
      },
      getThreadIDAsync: async () => 'async-preferred',
    })).toBe('async-preferred');
    expect(syncCalls).toBe(0);
    expect(await resolveThreadId({ getThreadID: () => null, getThreadIDAsync: async () => null })).toBeNull();
  });

  it('resolves message ids safely without calling getMessageID on unloaded messages', async () => {
    // Unloaded message should return null without invoking getMessageID (which would throw)
    let syncCalled = false;
    const unloadedMessage = {
      isLoaded: () => false,
      getMessageID: () => {
        syncCalled = true;
        throw new Error('tried to get message id before message is loaded');
      },
    };
    expect(await resolveMessageId(unloadedMessage)).toBeNull();
    expect(syncCalled).toBe(false);

    // Loaded message with getMessageIDAsync should prefer async
    let syncCalls = 0;
    const loadedMessage = {
      isLoaded: () => true,
      getMessageID: () => {
        syncCalls += 1;
        return 'sync-msg-id';
      },
      getMessageIDAsync: async () => 'async-msg-id',
    };
    expect(await resolveMessageId(loadedMessage)).toBe('async-msg-id');
    expect(syncCalls).toBe(0);

    // Fallback to sync when getMessageIDAsync is not present
    expect(await resolveMessageId({ isLoaded: () => true, getMessageID: () => 'legacy-msg' })).toBe('legacy-msg');

    // Throws inside getMessageID are gracefully swallowed
    expect(await resolveMessageId({
      isLoaded: () => true,
      getMessageID: () => {
        throw new Error('unexpected DOM failure');
      },
    })).toBeNull();
  });

  it('emits a row when the thread id arrives asynchronously', async () => {
    const events: MailboxEvent[] = [];
    const adapter = new InboxSdkAdapter('', { rowDebounceMs: 0 });
    adapter.bindSdk({
      Router: { handleAllRoutes() {} },
      Conversations: { registerThreadViewHandler() {} },
      Compose: { registerComposeViewHandler() {} },
      Lists: {
        registerThreadRowViewHandler(cb) {
          cb({ getThreadIDAsync: () => Promise.resolve('thread-async'), getSubject: () => 'Subject' });
        },
      },
    });
    await adapter.start((event) => events.push(event));
    await vi.waitFor(() => expect(events.some((event) => event.type === 'VISIBLE_ROWS_CHANGED')).toBe(true));
    const rows = events.find((event) => event.type === 'VISIBLE_ROWS_CHANGED');
    expect(rows && rows.type === 'VISIBLE_ROWS_CHANGED' ? rows.rows[0]?.threadId : '').toBe('thread-async');
    expect(events.some((event) => event.type === 'MESSAGE_ARRIVED')).toBe(false);
  });

  it('maps thread views containing unloaded message views safely and updates when messages load', async () => {
    const events: MailboxEvent[] = [];
    let threadHandler: ((tv: unknown) => void) | undefined;
    let messageHandler: ((mv: unknown) => void) | undefined;
    const adapter = new InboxSdkAdapter('', { rowDebounceMs: 0 });

    let message1Loaded = false;
    const mockMessage1 = {
      isLoaded: () => message1Loaded,
      getMessageID: () => {
        if (!message1Loaded) throw new Error('tried to get message id before message is loaded');
        return 'msg-1';
      },
      getMessageIDAsync: async () => {
        if (!message1Loaded) throw new Error('tried to get message id before message is loaded');
        return 'msg-1';
      },
      getSender: () => {
        if (!message1Loaded) throw new Error('not loaded');
        return { name: 'Alice', emailAddress: 'alice@example.com' };
      },
      getRecipientEmailAddresses: () => (message1Loaded ? ['me@example.com'] : []),
      getBodyElement: () => (message1Loaded ? ({ textContent: 'Hello world' } as HTMLElement) : null),
      getThreadView: () => mockThreadView,
    };

    const mockMessage2 = {
      isLoaded: () => true,
      getMessageIDAsync: async () => 'msg-2',
      getSender: () => ({ name: 'Bob', emailAddress: 'bob@example.com' }),
      getRecipientEmailAddresses: () => ['alice@example.com'],
      getBodyElement: () => ({ textContent: 'Reply from Bob' } as HTMLElement),
      getThreadView: () => mockThreadView,
    };

    const mockThreadView = {
      getThreadIDAsync: async () => 'thread-xyz',
      getSubject: () => 'Test conversation',
      getMessageViewsAll: () => [mockMessage1, mockMessage2],
    };

    adapter.bindSdk({
      Router: { handleAllRoutes() {} },
      Conversations: {
        registerThreadViewHandler(cb) {
          threadHandler = cb as (tv: unknown) => void;
        },
        registerMessageViewHandler(cb) {
          messageHandler = cb as (mv: unknown) => void;
        },
      },
      Compose: { registerComposeViewHandler() {} },
      Lists: { registerThreadRowViewHandler() {} },
    });

    await adapter.start((event) => events.push(event));
    expect(threadHandler).toBeDefined();

    // Trigger THREAD_OPENED while message 1 is unloaded
    threadHandler!(mockThreadView);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'THREAD_OPENED')).toBe(true));

    const opened = events.find((e) => e.type === 'THREAD_OPENED');
    expect(opened && opened.type === 'THREAD_OPENED').toBe(true);
    if (opened && opened.type === 'THREAD_OPENED') {
      expect(opened.thread.threadId).toBe('thread-xyz');
      expect(opened.thread.messages).toHaveLength(2);
      // Unloaded message receives safe fallback ID and empty body without throwing
      expect(opened.thread.messages[0]?.messageId).toBe('thread-xyz-msg-0');
      expect(opened.thread.messages[0]?.bodyText).toBe('');
      // Loaded message has resolved async ID and body
      expect(opened.thread.messages[1]?.messageId).toBe('msg-2');
      expect(opened.thread.messages[1]?.bodyText).toBe('Reply from Bob');
    }

    // Now message 1 loads (e.g. expanded by user in Gmail)
    message1Loaded = true;
    messageHandler!(mockMessage1);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'THREAD_DATA_UPDATED')).toBe(true));

    const updated = events.find((e) => e.type === 'THREAD_DATA_UPDATED');
    expect(updated && updated.type === 'THREAD_DATA_UPDATED').toBe(true);
    if (updated && updated.type === 'THREAD_DATA_UPDATED') {
      expect(updated.thread.messages[0]?.messageId).toBe('msg-1');
      expect(updated.thread.messages[0]?.bodyText).toBe('Hello world');
      expect(updated.thread.messages[0]?.sender.email).toBe('alice@example.com');
    }
  });

  it('does not stack observers when start is repeated, and stop disconnects', async () => {
    let observers = 0;
    const Original = globalThis.MutationObserver;
    class Counting extends Original {
      constructor(callback: MutationCallback) {
        super(callback);
        observers += 1;
      }
    }
    vi.stubGlobal('MutationObserver', Counting);
    const adapter = new DomFallbackAdapter({ debounceMs: 0 });
    await adapter.start(() => undefined);
    await adapter.start(() => undefined);
    expect(observers).toBe(1);
    await adapter.stop();
    expect(adapter.isStarted()).toBe(false);
    vi.stubGlobal('MutationObserver', Original);
  });
});
