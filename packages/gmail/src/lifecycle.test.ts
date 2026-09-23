/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { InboxSdkAdapter, type InboxSdkLike } from './InboxSdkAdapter.js';
import { CompositeGmailAdapter } from './index.js';
import { resolveThreadId } from './thread-id.js';
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
    expect(await resolveThreadId({ getThreadID: () => null, getThreadIDAsync: async () => null })).toBeNull();
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
