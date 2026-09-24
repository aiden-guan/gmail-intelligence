import { normalizeGmailId, type TrackedEmailSummary } from '@gi/tracking';
import { resolveMessageId, resolveThreadId, type MessageIdView, type ThreadIdView } from '@gi/gmail';

export type InboxSdkMessageViewLike = MessageIdView & {
  getViewState?: () => string;
  getThreadView?: () => ThreadIdView | null | undefined;
  on?: (event: string, cb: (payload?: any) => void) => void;
  destroyed?: boolean;
};

export type MessageSelfViewTrigger =
  | 'message-expanded'
  | 'message-load'
  | 'cache-reinspection';

export interface MessageSelfViewController {
  handleMessageView(messageView: InboxSdkMessageViewLike): void;
  reinspectActive(observedAt?: number): Promise<void>;
  getActiveCount(): number;
  destroy(): void;
}

export function createMessageSelfViewHandler(opts: {
  getEmails: () => TrackedEmailSummary[];
  onSelfView: (
    trackingId: string,
    gmailThreadId: string | null,
    gmailMessageId: string | null,
    observedAt: number,
    trigger: MessageSelfViewTrigger,
  ) => void;
}): MessageSelfViewController {
  const activeMessageViews = new Set<InboxSdkMessageViewLike>();

  async function inspectMessageView(
    messageView: InboxSdkMessageViewLike,
    observedAt = Date.now(),
    trigger: MessageSelfViewTrigger = 'message-expanded',
  ): Promise<void> {
    try {
      if (messageView.destroyed) {
        activeMessageViews.delete(messageView);
        return;
      }

      const state = typeof messageView.getViewState === 'function' ? messageView.getViewState() : null;
      if (state !== 'EXPANDED') {
        return;
      }

      const rawMessageId = await resolveMessageId(messageView);
      const messageId = normalizeGmailId(rawMessageId);
      if (!messageId) return;

      const emails = opts.getEmails();
      const match = emails.find((item) => normalizeGmailId(item.gmailMessageId) === messageId);
      if (match) {
        const threadView = typeof messageView.getThreadView === 'function' ? messageView.getThreadView() : null;
        const rawThreadId = threadView ? await resolveThreadId(threadView) : null;
        const threadId = normalizeGmailId(rawThreadId) || normalizeGmailId(match.gmailThreadId);
        opts.onSelfView(match.trackingId, threadId, messageId, observedAt, trigger);
      }
    } catch {
      /* message view inspection is optional */
    }
  }

  function handleMessageView(messageView: InboxSdkMessageViewLike): void {
    activeMessageViews.add(messageView);

    if (typeof messageView.on === 'function') {
      messageView.on('destroy', () => {
        activeMessageViews.delete(messageView);
      });

      messageView.on('viewStateChange', (event?: { newViewState?: string }) => {
        const currentState = typeof messageView.getViewState === 'function'
          ? messageView.getViewState()
          : event?.newViewState;
        if (currentState === 'EXPANDED') {
          const observedAt = Date.now();
          void inspectMessageView(messageView, observedAt, 'message-expanded');
        }
      });

      messageView.on('load', () => {
        const currentState = typeof messageView.getViewState === 'function'
          ? messageView.getViewState()
          : null;
        if (currentState === 'EXPANDED') {
          const observedAt = Date.now();
          void inspectMessageView(messageView, observedAt, 'message-load');
        }
      });
    }

    const initial = typeof messageView.getViewState === 'function' ? messageView.getViewState() : null;
    if (initial === 'EXPANDED') {
      const observedAt = Date.now();
      void inspectMessageView(messageView, observedAt, 'message-expanded');
    }
  }

  async function reinspectActive(observedAt = Date.now()): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const mv of [...activeMessageViews]) {
      if (mv.destroyed) {
        activeMessageViews.delete(mv);
        continue;
      }
      const state = typeof mv.getViewState === 'function' ? mv.getViewState() : null;
      if (state === 'EXPANDED') {
        promises.push(inspectMessageView(mv, observedAt, 'cache-reinspection'));
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
