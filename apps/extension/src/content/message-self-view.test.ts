/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import type { TrackedEmailSummary } from '@gi/tracking';
import { createMessageSelfViewHandler, type InboxSdkMessageViewLike } from './message-self-view';

type MockMessageViewOptions = {
  id?: string;
  loaded?: boolean;
  state?: 'EXPANDED' | 'COLLAPSED' | 'HIDDEN';
  threadId?: string;
};

function createMockMessageView(opts: MockMessageViewOptions = {}): InboxSdkMessageViewLike & {
  emit: (event: string, payload?: any) => void;
  setState: (next: 'EXPANDED' | 'COLLAPSED' | 'HIDDEN') => void;
  setLoaded: (loaded: boolean) => void;
} {
  let isLoaded = opts.loaded ?? true;
  let viewState = opts.state ?? 'COLLAPSED';
  const listeners = new Map<string, Array<(payload?: any) => void>>();

  const mv: InboxSdkMessageViewLike & {
    emit: (event: string, payload?: any) => void;
    setState: (next: 'EXPANDED' | 'COLLAPSED' | 'HIDDEN') => void;
    setLoaded: (loaded: boolean) => void;
  } = {
    isLoaded: () => isLoaded,
    getViewState: () => viewState,
    getMessageIDAsync: async () => {
      if (!isLoaded) throw new Error('tried to get message id before message is loaded');
      return opts.id || 'msg-1';
    },
    getMessageID: () => {
      if (!isLoaded) throw new Error('tried to get message id before message is loaded');
      return opts.id || 'msg-1';
    },
    getThreadView: () => ({
      getThreadIDAsync: async () => opts.threadId || 'thread-1',
      getThreadID: () => opts.threadId || 'thread-1',
    }),
    on: (event, cb) => {
      const list = listeners.get(event) || [];
      list.push(cb);
      listeners.set(event, list);
    },
    emit: (event, payload) => {
      listeners.get(event)?.forEach((cb) => cb(payload));
    },
    setState: (next) => {
      const old = viewState;
      viewState = next;
      mv.emit('viewStateChange', { newViewState: next, oldViewState: old, messageView: mv });
    },
    setLoaded: (loaded) => {
      isLoaded = loaded;
      if (loaded) mv.emit('load', { messageView: mv });
    },
    destroyed: false,
  };

  return mv;
}

const trackedEmailA: TrackedEmailSummary = {
  trackingId: 'trk_A',
  subject: 'Message A',
  sender: 'me@example.com',
  recipients: ['alice@example.com'],
  gmailThreadId: 'thread_X',
  gmailMessageId: 'abc123',
  sentAt: '2026-09-24T10:00:00.000Z',
  firstOpenedAt: null,
  lastOpenedAt: null,
  openCount: 0,
  clickCount: 0,
  notifyIfNoReply: false,
};

const trackedEmailB: TrackedEmailSummary = {
  trackingId: 'trk_B',
  subject: 'Message B',
  sender: 'me@example.com',
  recipients: ['alice@example.com'],
  gmailThreadId: 'thread_X',
  gmailMessageId: 'def456',
  sentAt: '2026-09-24T12:00:00.000Z',
  firstOpenedAt: null,
  lastOpenedAt: null,
  openCount: 0,
  clickCount: 0,
  notifyIfNoReply: false,
};

describe('InboxSDK MessageView view-state and self-view integration', () => {
  // Case A: MessageView already loaded, state = COLLAPSED -> handler registers -> no SELF_VIEW -> viewStateChange to EXPANDED -> SELF_VIEW
  it('Case A: already loaded COLLAPSED does not fire SELF_VIEW until viewStateChange to EXPANDED', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'abc123', loaded: true, state: 'COLLAPSED' });
    handler.handleMessageView(mv);

    // Initial registration while COLLAPSED must not emit SELF_VIEW
    await vi.waitFor(() => expect(onSelfView).not.toHaveBeenCalled());

    // User expands the message view
    mv.setState('EXPANDED');

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  // Case B: MessageView already loaded, state = EXPANDED -> handler registers -> SELF_VIEW emitted immediately
  it('Case B: already loaded EXPANDED emits SELF_VIEW immediately on registration', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'abc123', loaded: true, state: 'EXPANDED' });
    handler.handleMessageView(mv);

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  // Case C: MessageView initially unloaded + COLLAPSED -> load fires -> still COLLAPSED -> no SELF_VIEW -> later EXPANDED -> SELF_VIEW
  it('Case C: unloaded + COLLAPSED does not fire on load while COLLAPSED, fires when later EXPANDED', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'abc123', loaded: false, state: 'COLLAPSED' });
    handler.handleMessageView(mv);

    // Initial: no call
    expect(onSelfView).not.toHaveBeenCalled();

    // Load event fires while still collapsed
    mv.setLoaded(true);
    await vi.waitFor(() => expect(onSelfView).not.toHaveBeenCalled());

    // Later expanded
    mv.setState('EXPANDED');
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  // Case D: MessageView initially unloaded + EXPANDED -> load fires -> resolve ID -> SELF_VIEW
  it('Case D: unloaded + EXPANDED waits for load event then resolves ID and emits SELF_VIEW', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'abc123', loaded: false, state: 'EXPANDED' });
    handler.handleMessageView(mv);

    // Initially unloaded -> resolveMessageId returns null -> no emission yet
    expect(onSelfView).not.toHaveBeenCalled();

    // Now message finishes loading
    mv.setLoaded(true);
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_LOAD');
  });

  // ID Normalization tests: msg-a:, msg-f:, #msg-a:
  it('normalizes InboxSDK message ID prefixes (msg-a:, msg-f:, #msg-a:) against stored tracked ID', async () => {
    // 1. stored = "abc123", view = "msg-a:abc123"
    {
      const onSelfView = vi.fn();
      const handler = createMessageSelfViewHandler({
        getEmails: () => [trackedEmailA],
        onSelfView,
      });
      const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
      handler.handleMessageView(mv);
      await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED'));
    }

    // 2. stored = "abc123", view = "msg-f:abc123"
    {
      const onSelfView = vi.fn();
      const handler = createMessageSelfViewHandler({
        getEmails: () => [trackedEmailA],
        onSelfView,
      });
      const mv = createMockMessageView({ id: 'msg-f:abc123', loaded: true, state: 'EXPANDED' });
      handler.handleMessageView(mv);
      await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED'));
    }

    // 3. stored = "abc123", view = "#msg-a:abc123"
    {
      const onSelfView = vi.fn();
      const handler = createMessageSelfViewHandler({
        getEmails: () => [trackedEmailA],
        onSelfView,
      });
      const mv = createMockMessageView({ id: '#msg-a:abc123', loaded: true, state: 'EXPANDED' });
      handler.handleMessageView(mv);
      await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED'));
    }
  });

  // Section 24: Cache Race Test
  it('handles tracked-email cache arriving after MessageView registration', async () => {
    let emails: TrackedEmailSummary[] = [];
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => emails,
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
    handler.handleMessageView(mv);

    // Wait for initial async registration inspection to settle
    await new Promise((resolve) => setTimeout(resolve, 20));

    // No match initially because cache was empty
    expect(onSelfView).not.toHaveBeenCalled();

    // Later tracked-email cache arrives from background
    emails = [trackedEmailA];
    await handler.reinspectActive();

    expect(onSelfView).toHaveBeenCalledTimes(1);
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'CACHE_REINSPECTION');
  });

  // Section 5: Mandatory Regression Test
  it('Priority 1 Regression Test: cache refresh while message remains expanded does NOT fabricate a new SELF_VIEW', async () => {
    const onSelfView = vi.fn();
    const emails = [trackedEmailA];
    const handler = createMessageSelfViewHandler({
      getEmails: () => emails,
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
    // T = 0: sender expands message
    const t0 = 1000;
    vi.setSystemTime(t0);
    handler.handleMessageView(mv);

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', t0, 'MESSAGE_EXPANDED');

    // Message remains expanded.
    // T = 60s: recipient legitimately opens at T = 60s
    const t60 = t0 + 60_000;
    vi.setSystemTime(t60);

    // Cache refresh runs at T=60
    await handler.reinspectActive();

    // EXPECTED: NO new SELF_VIEW at T=60!
    expect(onSelfView).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('late cache arrival preserves original expansion timestamp T=0 instead of T=60', async () => {
    let emails: TrackedEmailSummary[] = [];
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => emails,
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
    const t0 = 1000;
    vi.setSystemTime(t0);
    handler.handleMessageView(mv);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSelfView).not.toHaveBeenCalled();

    // Cache arrives at T=60s
    const t60 = t0 + 60_000;
    vi.setSystemTime(t60);
    emails = [trackedEmailA];
    await handler.reinspectActive();

    expect(onSelfView).toHaveBeenCalledTimes(1);
    // MUST have original expandedAt (t0), NOT t60!
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', t0, 'CACHE_REINSPECTION');

    vi.useRealTimers();
  });

  // Section 29: Multiple tracked messages in same thread remain isolated
  it('isolates multiple tracked messages in the same Gmail thread by message ID', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA, trackedEmailB],
      onSelfView,
    });

    // Message A is expanded in thread X
    const mvA = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED', threadId: 'thread_X' });
    // Message B is collapsed in thread X
    const mvB = createMockMessageView({ id: 'msg-f:def456', loaded: true, state: 'COLLAPSED', threadId: 'thread_X' });

    handler.handleMessageView(mvA);
    handler.handleMessageView(mvB);

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    // ONLY trk_A is emitted! trk_B is NOT emitted!
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED');

    // Now sender expands Message B
    mvB.setState('EXPANDED');
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(2));
    // Message B emits its own SELF_VIEW
    expect(onSelfView).toHaveBeenLastCalledWith('trk_B', 'thread_X', 'def456', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  // MessageView destruction cleans up active set
  it('removes destroyed MessageViews from active registry', async () => {
    let emails: TrackedEmailSummary[] = [];
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => emails,
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
    handler.handleMessageView(mv);
    expect(handler.getActiveCount()).toBe(1);

    // Destroy view
    mv.destroyed = true;
    mv.emit('destroy');
    expect(handler.getActiveCount()).toBe(0);

    // Reinspect does not call onSelfView for destroyed view
    emails = [trackedEmailA];
    await handler.reinspectActive();
    expect(onSelfView).not.toHaveBeenCalled();
  });
});
