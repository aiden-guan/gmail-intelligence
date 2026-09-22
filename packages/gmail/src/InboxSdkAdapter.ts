import type { GmailActionResult, GmailCapabilities } from '@gi/shared';
import { EMPTY_CAPABILITIES } from './capabilities.js';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import type {
  ComposeViewState,
  CurrentThreadView,
  GmailAdapter,
  MailboxEventHandler,
  VisibleThreadRow,
} from './types.js';

/**
 * InboxSDK primary adapter.
 * Requires @inboxsdk/core loaded in the extension content script + pageWorld injection.
 * Degrades gracefully when SDK is unavailable (returns capability false).
 */
export class InboxSdkAdapter implements GmailAdapter {
  readonly name = 'inboxsdk';
  private sdk: InboxSdkLike | null = null;
  private handler: MailboxEventHandler | null = null;
  private fallback = new DomFallbackAdapter();
  private unsubs: Array<() => void> = [];

  constructor(private readonly appId: string) {}

  async detectCapabilities(): Promise<GmailCapabilities> {
    const available = Boolean(this.sdk) || (await this.tryDetectGlobal());
    return {
      ...EMPTY_CAPABILITIES,
      inboxSdkAvailable: available,
      // Native Gmail label mutation via InboxSDK Labels is optional and often flaky;
      // we keep virtual labels as the default and do not claim native mutation.
      persistentNativeLabelMutationAvailable: false,
      domFallbackAvailable: true,
    };
  }

  private async tryDetectGlobal(): Promise<boolean> {
    const w = typeof window !== 'undefined' ? (window as unknown as { InboxSDK?: unknown }) : null;
    return Boolean(w?.InboxSDK);
  }

  /**
   * Bind an already-loaded InboxSDK instance (from content script after InboxSDK.load).
   */
  bindSdk(sdk: InboxSdkLike): void {
    this.sdk = sdk;
  }

  async start(handler: MailboxEventHandler): Promise<void> {
    this.handler = handler;
    if (!this.sdk) {
      await this.fallback.start(handler);
      handler({
        type: 'capability_changed',
        capabilities: await this.detectCapabilities(),
        at: Date.now(),
      });
      return;
    }

    const sdk = this.sdk;
    try {
      sdk.Router.handleAllRoutes((routeView) => {
        handler({
          type: 'route_changed',
          route: mapRoute(routeView.getRouteType?.() || 'unknown'),
          at: Date.now(),
        });
      });
    } catch {
      // degrade
    }

    try {
      sdk.Conversations.registerThreadViewHandler((threadView) => {
        const thread = mapThreadView(threadView);
        if (thread) handler({ type: 'thread_opened', thread, at: Date.now() });
      });
    } catch {
      /* ignore */
    }

    try {
      sdk.Compose.registerComposeViewHandler((composeView) => {
        const compose = mapCompose(composeView);
        handler({ type: 'compose_opened', compose, at: Date.now() });
        composeView.on?.('sent', () => {
          handler({ type: 'compose_sent', compose, at: Date.now() });
        });
      });
    } catch {
      /* ignore */
    }

    try {
      sdk.Lists.registerThreadRowViewHandler((rowView) => {
        const row = mapRow(rowView);
        if (row) handler({ type: 'new_message', row, at: Date.now() });
      });
    } catch {
      /* ignore */
    }

    handler({
      type: 'capability_changed',
      capabilities: await this.detectCapabilities(),
      at: Date.now(),
    });
  }

  async stop(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    await this.fallback.stop();
    this.handler = null;
  }

  async observeInbox() {
    return this.fallback.observeInbox();
  }
  async observeNewMessages() {
    return ok('observeNewMessages');
  }
  async observeThreadOpened() {
    return ok('observeThreadOpened');
  }
  async observeCompose() {
    return ok('observeCompose');
  }
  async getVisibleThreadMetadata() {
    return this.fallback.getVisibleThreadMetadata();
  }
  async getCurrentThread() {
    return this.fallback.getCurrentThread();
  }
  async getCurrentCompose() {
    return this.fallback.getCurrentCompose();
  }

  async openThread(threadId: string) {
    if (!this.sdk) return this.fallback.openThread(threadId);
    try {
      this.sdk.Router.goto?.(`#inbox/${threadId}`);
      return ok('openThread');
    } catch (e) {
      return fail('openThread', String(e));
    }
  }

  async archiveThread(threadId: string) {
    // Prefer toolbars via DOM verification path in GmailActionAdapter;
    // InboxSDK ThreadView.addButton paths vary — use fallback click.
    return this.fallback.archiveThread(threadId);
  }

  async markRead(threadId: string) {
    return this.fallback.markRead(threadId);
  }
  async markUnread(threadId: string) {
    return this.fallback.markUnread(threadId);
  }
  async starThread(threadId: string) {
    return this.fallback.starThread(threadId);
  }
  async createReplyDraft(threadId: string) {
    return this.fallback.createReplyDraft(threadId);
  }
  async insertComposeBody(text: string) {
    return this.fallback.insertComposeBody(text);
  }
  async navigateToSearch(query: string) {
    if (this.sdk?.Router?.goto) {
      try {
        this.sdk.Router.goto(`#search/${encodeURIComponent(query)}`);
        return ok('navigateToSearch');
      } catch {
        /* fall through */
      }
    }
    return this.fallback.navigateToSearch(query);
  }
  async navigateToInbox() {
    if (this.sdk?.Router?.goto) {
      try {
        this.sdk.Router.goto('#inbox');
        return ok('navigateToInbox');
      } catch {
        /* fall through */
      }
    }
    return this.fallback.navigateToInbox();
  }

  /** Add a virtual category chip on a thread row when InboxSDK is available. */
  addRowLabel(rowView: { addLabel?: (desc: { title: string; foregroundColor?: string; backgroundColor?: string }) => void }, title: string, colors: { fg: string; bg: string }): boolean {
    if (!rowView.addLabel) return false;
    try {
      rowView.addLabel({ title, foregroundColor: colors.fg, backgroundColor: colors.bg });
      return true;
    } catch {
      return false;
    }
  }
}

function ok(capability: string): GmailActionResult {
  return { success: true, capability };
}
function fail(capability: string, error: string, retryable = true): GmailActionResult {
  return { success: false, capability, error, retryable };
}

function mapRoute(t: string): CurrentThreadView['route'] {
  const s = t.toLowerCase();
  if (s.includes('inbox')) return 'inbox';
  if (s.includes('sent')) return 'sent';
  if (s.includes('draft')) return 'drafts';
  if (s.includes('search')) return 'search';
  if (s.includes('star')) return 'starred';
  return 'unknown';
}

function mapRow(rowView: ThreadRowViewLike): VisibleThreadRow | null {
  const threadId = rowView.getThreadID?.() || rowView.getThreadIDAsync?.();
  if (!threadId || typeof threadId !== 'string') return null;
  return {
    threadId,
    subject: rowView.getSubject?.() || '',
    snippet: '',
    participants: [],
    unread: Boolean(rowView.isSelected?.() === false && rowView.getElement?.()),
    starred: false,
    labels: [],
  };
}

function mapThreadView(tv: ThreadViewLike): CurrentThreadView | null {
  const threadId = tv.getThreadID?.() || tv.getThreadIDAsync?.();
  if (!threadId || typeof threadId !== 'string') return null;
  const subject = tv.getSubject?.() || '';
  const messageViews = tv.getMessageViewsAll?.() || tv.getMessageViews?.() || [];
  return {
    threadId,
    subject,
    route: 'unknown',
    messages: messageViews.map((mv, i) => ({
      messageId: mv.getMessageID?.() || `${threadId}-${i}`,
      threadId,
      sender: { email: mv.getSender?.()?.emailAddress || 'unknown@local', name: mv.getSender?.()?.name },
      recipients: (mv.getRecipientEmailAddresses?.() || []).map((e) => ({ email: e })),
      cc: [],
      timestamp: new Date().toISOString(),
      bodyText: mv.getBodyElement?.()?.textContent?.trim() || '',
      attachmentsMetadata: [],
    })),
  };
}

function mapCompose(cv: ComposeViewLike): ComposeViewState {
  return {
    composeId: cv.getThreadID?.() || `compose-${Date.now()}`,
    to: (cv.getToRecipients?.() || []).map((r) => ({ email: r.emailAddress, name: r.name })),
    cc: (cv.getCcRecipients?.() || []).map((r) => ({ email: r.emailAddress, name: r.name })),
    bcc: (cv.getBccRecipients?.() || []).map((r) => ({ email: r.emailAddress, name: r.name })),
    subject: cv.getSubject?.() || '',
    bodyText: cv.getBodyElement?.()?.textContent || '',
    isReply: Boolean(cv.getThreadID?.()),
    threadId: cv.getThreadID?.() || undefined,
  };
}

/** Minimal structural types — avoid hard dependency on InboxSDK types at compile time. */
export type InboxSdkLike = {
  Router: {
    handleAllRoutes: (cb: (rv: { getRouteType?: () => string }) => void) => void;
    goto?: (path: string) => void;
  };
  Conversations: {
    registerThreadViewHandler: (cb: (tv: ThreadViewLike) => void) => void;
  };
  Compose: {
    registerComposeViewHandler: (cb: (cv: ComposeViewLike) => void) => void;
  };
  Lists: {
    registerThreadRowViewHandler: (cb: (rv: ThreadRowViewLike) => void) => void;
  };
  NavMenu?: {
    addNavItem: (desc: unknown) => unknown;
  };
};

type ThreadRowViewLike = {
  getThreadID?: () => string;
  getThreadIDAsync?: () => string | Promise<string>;
  getSubject?: () => string;
  isSelected?: () => boolean;
  getElement?: () => HTMLElement;
  addLabel?: (d: { title: string; foregroundColor?: string; backgroundColor?: string }) => void;
};

type ThreadViewLike = {
  getThreadID?: () => string;
  getThreadIDAsync?: () => string | Promise<string>;
  getSubject?: () => string;
  getMessageViews?: () => MessageViewLike[];
  getMessageViewsAll?: () => MessageViewLike[];
};

type MessageViewLike = {
  getMessageID?: () => string;
  getSender?: () => { name?: string; emailAddress: string };
  getRecipientEmailAddresses?: () => string[];
  getBodyElement?: () => HTMLElement | null;
};

type ComposeViewLike = {
  getThreadID?: () => string | null;
  getToRecipients?: () => { emailAddress: string; name?: string }[];
  getCcRecipients?: () => { emailAddress: string; name?: string }[];
  getBccRecipients?: () => { emailAddress: string; name?: string }[];
  getSubject?: () => string;
  getBodyElement?: () => HTMLElement | null;
  on?: (event: string, cb: () => void) => void;
  insertTextIntoBodyAtCursor?: (text: string) => void;
};
