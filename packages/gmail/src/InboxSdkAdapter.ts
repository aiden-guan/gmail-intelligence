import type { GmailActionResult, GmailCapabilities } from '@gi/shared';
import { EMPTY_CAPABILITIES } from './capabilities.js';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { queryFirst, SELECTORS } from './selectors.js';
import { resolveThreadId, type ThreadIdView } from './thread-id.js';
import type {
  ComposeViewState,
  CurrentThreadView,
  GmailAdapter,
  MailboxEventHandler,
  VisibleThreadRow,
} from './types.js';

/**
 * InboxSDK primary adapter.
 * Handlers register once per start. stop() invalidates them so a later start cannot double-fire.
 */
export class InboxSdkAdapter implements GmailAdapter {
  readonly name = 'inboxsdk';
  private sdk: InboxSdkLike | null = null;
  private handler: MailboxEventHandler | null = null;
  private readonly fallback = new DomFallbackAdapter();
  private generation = 0;
  private started = false;
  private rowTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRows = new Map<string, VisibleThreadRow>();

  constructor(
    private readonly appId: string,
    private readonly opts: { rowDebounceMs?: number } = {},
  ) {}

  isBound(): boolean {
    return this.sdk != null;
  }

  async detectCapabilities(): Promise<GmailCapabilities> {
    return {
      ...EMPTY_CAPABILITIES,
      inboxSdkAvailable: this.isBound(),
      persistentNativeLabelMutationAvailable: false,
      domFallbackAvailable: true,
    };
  }

  bindSdk(sdk: InboxSdkLike): void {
    this.sdk = sdk;
  }

  async start(handler: MailboxEventHandler): Promise<void> {
    if (this.started) return;
    this.handler = handler;
    this.started = true;
    const generation = ++this.generation;
    const emit: MailboxEventHandler = (event) => {
      if (generation !== this.generation || !this.handler) return;
      this.handler(event);
    };

    if (!this.sdk) {
      await this.fallback.start(emit);
      emit({
        type: 'CAPABILITY_CHANGED',
        capabilities: await this.detectCapabilities(),
        at: Date.now(),
      });
      return;
    }

    const sdk = this.sdk;
    try {
      sdk.Router.handleAllRoutes((routeView) => {
        emit({
          type: 'ROUTE_CHANGED',
          route: mapRoute(routeView.getRouteType?.() || 'unknown'),
          at: Date.now(),
        });
      });
    } catch {
      /* degrade */
    }

    try {
      sdk.Conversations.registerThreadViewHandler((threadView) => {
        void mapThreadView(threadView).then((thread) => {
          if (thread) emit({ type: 'THREAD_OPENED', thread, at: Date.now() });
        });
      });
    } catch {
      /* ignore */
    }

    try {
      sdk.Compose.registerComposeViewHandler((composeView) => {
        void mapCompose(composeView).then((compose) => {
          emit({ type: 'COMPOSE_OPENED', compose, at: Date.now() });
          composeView.on?.('sent', () => {
            emit({ type: 'COMPOSE_SENT', compose, at: Date.now() });
          });
        });
      });
    } catch {
      /* ignore */
    }

    try {
      sdk.Lists.registerThreadRowViewHandler((rowView) => {
        void mapRow(rowView).then((row) => {
          if (!row || generation !== this.generation) return;
          this.pendingRows.set(row.threadId, row);
          if (this.rowTimer) clearTimeout(this.rowTimer);
          this.rowTimer = setTimeout(() => {
            const rows = [...this.pendingRows.values()];
            this.pendingRows.clear();
            emit({ type: 'VISIBLE_ROWS_CHANGED', rows, at: Date.now() });
          }, this.opts.rowDebounceMs ?? 200);
        });
      });
    } catch {
      /* ignore */
    }

    emit({
      type: 'CAPABILITY_CHANGED',
      capabilities: await this.detectCapabilities(),
      at: Date.now(),
    });
  }

  async stop(): Promise<void> {
    this.generation += 1;
    if (this.rowTimer) clearTimeout(this.rowTimer);
    this.rowTimer = null;
    this.pendingRows.clear();
    this.started = false;
    await this.fallback.stop();
    this.handler = null;
  }

  isStarted(): boolean {
    return this.started;
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
      return { ...ok('openThread'), threadId, verified: false };
    } catch (error) {
      return fail('openThread', String(error));
    }
  }

  async archiveThread(threadId: string) {
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

  addRowLabel(
    rowView: { addLabel?: (desc: { title: string; foregroundColor?: string; backgroundColor?: string }) => void },
    title: string,
    colors: { fg: string; bg: string },
  ): boolean {
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
  return { success: true, capability, action: capability, verified: false };
}
function fail(capability: string, error: string, retryable = true): GmailActionResult {
  return { success: false, capability, action: capability, error, reason: error, retryable, verified: false };
}

function mapRoute(value: string): CurrentThreadView['route'] {
  const route = value.toLowerCase();
  if (route.includes('inbox')) return 'inbox';
  if (route.includes('sent')) return 'sent';
  if (route.includes('draft')) return 'drafts';
  if (route.includes('search')) return 'search';
  if (route.includes('star')) return 'starred';
  return 'unknown';
}

async function mapRow(rowView: ThreadRowViewLike): Promise<VisibleThreadRow | null> {
  const threadId = await resolveThreadId(rowView);
  if (!threadId) return null;
  const element = rowView.getElement?.() || null;
  const subjectEl = element ? queryFirst(element, SELECTORS.threadRowSubject) : null;
  const snippetEl = element ? queryFirst(element, SELECTORS.threadRowSnippet) : null;
  const senderEl = element ? queryFirst(element, SELECTORS.threadRowSender) : null;
  const contact = rowView.getContacts?.()?.find((item) => item.emailAddress);
  const email = senderEl?.getAttribute('email') || contact?.emailAddress;
  const sender = email
    ? { email, name: senderEl?.textContent?.trim() || contact?.name }
    : undefined;
  if (element) element.setAttribute('data-gi-thread-id', threadId);
  return {
    threadId,
    subject: rowView.getSubject?.() || subjectEl?.textContent?.trim() || '',
    snippet: snippetEl?.textContent?.trim() || '',
    participants: sender ? [sender] : [],
    latestSender: sender,
    unread: Boolean(element?.classList.contains('zE')),
    starred: Boolean(element?.querySelector('[aria-label="Starred"]')),
    labels: [],
  };
}

async function mapThreadView(view: ThreadViewLike): Promise<CurrentThreadView | null> {
  const threadId = await resolveThreadId(view);
  if (!threadId) return null;
  const subject = view.getSubject?.() || '';
  const messageViews = view.getMessageViewsAll?.() || view.getMessageViews?.() || [];
  return {
    threadId,
    subject,
    route: 'unknown',
    messages: messageViews.map((message, index) => ({
      messageId: message.getMessageID?.() || `${threadId}-msg-${index}`,
      threadId,
      sender: {
        email: message.getSender?.()?.emailAddress || 'unknown@local',
        name: message.getSender?.()?.name,
      },
      recipients: (message.getRecipientEmailAddresses?.() || []).map((email) => ({ email })),
      cc: [],
      bodyText: message.getBodyElement?.()?.textContent?.trim() || '',
      attachmentsMetadata: [],
    })),
  };
}

async function mapCompose(view: ComposeViewLike): Promise<ComposeViewState> {
  const threadId = await resolveThreadId(view as ThreadIdView);
  return {
    composeId: threadId || view.getElement?.()?.id || `compose-${Math.random().toString(36).slice(2, 8)}`,
    to: (view.getToRecipients?.() || []).map((recipient) => ({
      email: recipient.emailAddress,
      name: recipient.name,
    })),
    cc: (view.getCcRecipients?.() || []).map((recipient) => ({
      email: recipient.emailAddress,
      name: recipient.name,
    })),
    bcc: (view.getBccRecipients?.() || []).map((recipient) => ({
      email: recipient.emailAddress,
      name: recipient.name,
    })),
    subject: view.getSubject?.() || '',
    bodyText: view.getBodyElement?.()?.textContent || '',
    isReply: Boolean(threadId),
    threadId: threadId || undefined,
  };
}

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

type ThreadRowViewLike = ThreadIdView & {
  getSubject?: () => string;
  isSelected?: () => boolean;
  getElement?: () => HTMLElement;
  getContacts?: () => Array<{ emailAddress?: string; name?: string }>;
  addLabel?: (d: { title: string; foregroundColor?: string; backgroundColor?: string }) => void;
};

type ThreadViewLike = ThreadIdView & {
  getSubject?: () => string;
  getMessageViews?: () => MessageViewLike[];
  getMessageViewsAll?: () => MessageViewLike[];
  addSidebarContentPanel?: (desc: unknown) => { remove?: () => void };
};

type MessageViewLike = {
  getMessageID?: () => string;
  getSender?: () => { name?: string; emailAddress: string };
  getRecipientEmailAddresses?: () => string[];
  getBodyElement?: () => HTMLElement | null;
};

type ComposeViewLike = ThreadIdView & {
  getToRecipients?: () => { emailAddress: string; name?: string }[];
  getCcRecipients?: () => { emailAddress: string; name?: string }[];
  getBccRecipients?: () => { emailAddress: string; name?: string }[];
  getSubject?: () => string;
  getBodyElement?: () => HTMLElement | null;
  getElement?: () => HTMLElement;
  on?: (event: string, cb: () => void) => void;
  insertTextIntoBodyAtCursor?: (text: string) => void;
};
