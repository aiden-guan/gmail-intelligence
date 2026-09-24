import { normalizeGmailId, type TrackedEmailSummary } from '@gi/tracking';
import { resolveMessageId, resolveThreadId, type MessageIdView, type ThreadIdView } from '@gi/gmail';

export type InboxSdkMessageViewLike = MessageIdView & {
  getViewState?: () => string;
  getThreadView?: () => ThreadIdView | null | undefined;
  on?: (event: string, cb: (payload?: any) => void) => void;
  destroyed?: boolean;
};

export type SelfViewSource =
  | 'ROW_INTERACTION'
  | 'MESSAGE_EXPANDED'
  | 'MESSAGE_LOAD'
  | 'CACHE_REINSPECTION';

/** Backwards-compatible alias */
export type MessageSelfViewTrigger =
  | SelfViewSource
  | 'message-expanded'
  | 'message-load'
  | 'cache-reinspection';

export interface MessageSelfViewController {
  handleMessageView(messageView: InboxSdkMessageViewLike): void;
  reinspectActive(): Promise<void>;
  getActiveCount(): number;
  destroy(): void;
}

export type ActiveMessageViewState = {
  view: InboxSdkMessageViewLike;
  expandedAt: number | null;
  loadedAt: number | null;
  lastReportedTrackingId?: string;
  lastReportedMessageId?: string;
  lastExpandedClaimAt?: number;
  lastLoadedClaimAt?: number;
};

export function createMessageSelfViewHandler(opts: {
  getEmails: () => TrackedEmailSummary[];
  onSelfView: (
    trackingId: string,
    gmailThreadId: string | null,
    gmailMessageId: string | null,
    observedAt: number,
    trigger: SelfViewSource,
  ) => void;
  onCollapsed?: (trackingId: string, gmailMessageId: string | null) => void;
}): MessageSelfViewController {
  const activeMessageViews = new Map<InboxSdkMessageViewLike, ActiveMessageViewState>();

  async function inspectMessageView(
    state: ActiveMessageViewState,
    source: SelfViewSource = 'MESSAGE_EXPANDED',
    specificTimestamp?: number,
  ): Promise<void> {
    const messageView = state.view;
    try {
      if (messageView.destroyed) {
        activeMessageViews.delete(messageView);
        return;
      }

      const viewState = typeof messageView.getViewState === 'function' ? messageView.getViewState() : null;
      if (viewState !== 'EXPANDED') {
        return;
      }

      // Determine observation time based on source
      let observedAt: number;
      if (source === 'MESSAGE_LOAD') {
        observedAt = specificTimestamp ?? state.loadedAt ?? Date.now();
        state.loadedAt = observedAt;
      } else {
        observedAt = specificTimestamp ?? state.expandedAt ?? Date.now();
        state.expandedAt = observedAt;
      }

      const rawMessageId = await resolveMessageId(messageView);
      const messageId = normalizeGmailId(rawMessageId);
      if (!messageId) return;

      const emails = opts.getEmails();
      const match = emails.find((item) => normalizeGmailId(item.gmailMessageId) === messageId);
      if (match) {
        // Source-specific deduplication
        if (source === 'MESSAGE_LOAD') {
          if (
            state.lastReportedTrackingId === match.trackingId &&
            state.lastReportedMessageId === messageId &&
            state.lastLoadedClaimAt === observedAt
          ) {
            return;
          }
          state.lastLoadedClaimAt = observedAt;
        } else if (source === 'MESSAGE_EXPANDED') {
          if (
            state.lastReportedTrackingId === match.trackingId &&
            state.lastReportedMessageId === messageId &&
            state.lastExpandedClaimAt === observedAt
          ) {
            return;
          }
          state.lastExpandedClaimAt = observedAt;
        } else if (source === 'CACHE_REINSPECTION') {
          if (
            state.lastReportedTrackingId === match.trackingId &&
            state.lastReportedMessageId === messageId
          ) {
            return;
          }
        }

        state.lastReportedTrackingId = match.trackingId;
        state.lastReportedMessageId = messageId;

        const threadView = typeof messageView.getThreadView === 'function' ? messageView.getThreadView() : null;
        const rawThreadId = threadView ? await resolveThreadId(threadView) : null;
        const threadId = normalizeGmailId(rawThreadId) || normalizeGmailId(match.gmailThreadId);
        opts.onSelfView(match.trackingId, threadId, messageId, observedAt, source);
      }
    } catch (error) {
      console.warn('[gi][self-view] Message view inspection error', error);
    }
  }

  function handleMessageView(messageView: InboxSdkMessageViewLike): void {
    let state = activeMessageViews.get(messageView);
    if (!state) {
      state = {
        view: messageView,
        expandedAt: null,
        loadedAt: null,
      };
      activeMessageViews.set(messageView, state);
    }

    if (typeof messageView.on === 'function') {
      messageView.on('destroy', () => {
        activeMessageViews.delete(messageView);
      });

      messageView.on('viewStateChange', (event?: { newViewState?: string }) => {
        const currentState = typeof messageView.getViewState === 'function'
          ? messageView.getViewState()
          : event?.newViewState;
        if (currentState === 'EXPANDED') {
          state.expandedAt = Date.now();
          void inspectMessageView(state, 'MESSAGE_EXPANDED', state.expandedAt);
        } else {
          if (state.lastReportedTrackingId) {
            opts.onCollapsed?.(state.lastReportedTrackingId, state.lastReportedMessageId || null);
          }
          state.expandedAt = null;
          state.loadedAt = null;
          state.lastExpandedClaimAt = undefined;
          state.lastLoadedClaimAt = undefined;
          state.lastReportedTrackingId = undefined;
          state.lastReportedMessageId = undefined;
        }
      });

      messageView.on('load', () => {
        const currentState = typeof messageView.getViewState === 'function'
          ? messageView.getViewState()
          : null;
        if (currentState === 'EXPANDED') {
          state.loadedAt = Date.now();
          void inspectMessageView(state, 'MESSAGE_LOAD', state.loadedAt);
        }
      });
    }

    const initial = typeof messageView.getViewState === 'function' ? messageView.getViewState() : null;
    if (initial === 'EXPANDED') {
      if (!state.expandedAt) {
        state.expandedAt = Date.now();
      }
      void inspectMessageView(state, 'MESSAGE_EXPANDED', state.expandedAt);
    }
  }

  async function reinspectActive(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const state of [...activeMessageViews.values()]) {
      const mv = state.view;
      if (mv.destroyed) {
        activeMessageViews.delete(mv);
        continue;
      }
      const viewState = typeof mv.getViewState === 'function' ? mv.getViewState() : null;
      if (viewState === 'EXPANDED') {
        if (!state.expandedAt) {
          state.expandedAt = Date.now();
        }
        promises.push(inspectMessageView(state, 'CACHE_REINSPECTION', state.expandedAt));
      }
    }
    await Promise.all(promises);
  }

  return {
    handleMessageView,
    reinspectActive,
    getActiveCount: () => activeMessageViews.size,
    destroy: () => {
      activeMessageViews.clear();
    },
  };
}
