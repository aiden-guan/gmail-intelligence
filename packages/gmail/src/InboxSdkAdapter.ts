import type { GmailActionResult, GmailCapabilities } from '@gi/shared';
import { EMPTY_CAPABILITIES } from './capabilities.js';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { queryFirst, SELECTORS } from './selectors.js';
import { resolveMessageId, resolveThreadId, type MessageIdView, type ThreadIdView } from './thread-id.js';
import type {
  ComposeHandle,
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
  private activeComposeView: unknown = null;
  private composeHandles = new Map<string, ComposeHandle>();
  private currentThread: CurrentThreadView | null = null;

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
        const attachMessageListeners = () => {
          const mvs = threadView.getMessageViewsAll?.() || threadView.getMessageViews?.() || [];
          for (const mv of mvs) {
            mv.on?.('load', () => {
              if (generation !== this.generation) return;
              void mapThreadView(threadView)
                .then((thread) => {
                  if (thread && generation === this.generation) {
                    this.currentThread = thread;
                    emit({ type: 'THREAD_DATA_UPDATED', thread, at: Date.now() });
                  }
                })
                .catch(() => {});
            });
          }
        };
        attachMessageListeners();

        threadView.on?.('destroy', () => {
          if (generation === this.generation && this.currentThread?.threadId === threadView.getThreadID?.()) {
            this.currentThread = null;
          }
        });

        void mapThreadView(threadView)
          .then((thread) => {
            if (thread && generation === this.generation) {
              this.currentThread = thread;
              emit({ type: 'THREAD_OPENED', thread, at: Date.now() });
            }
          })
          .catch((error) => {
            console.warn('[gi] Failed to map thread view', error);
          });
      });
    } catch {
      /* ignore */
    }

    try {
      sdk.Conversations.registerMessageViewHandler?.((messageView) => {
        if (generation !== this.generation) return;
        const threadView = messageView.getThreadView?.();
        if (threadView) {
          void mapThreadView(threadView)
            .then((thread) => {
              if (thread && generation === this.generation) {
                this.currentThread = thread;
                emit({ type: 'THREAD_DATA_UPDATED', thread, at: Date.now() });
              }
            })
            .catch(() => {});
        }
      });
    } catch {
      /* ignore */
    }

    try {
      sdk.Compose.registerComposeViewHandler((composeView) => {
        this.activeComposeView = composeView;
        const composeId = `compose-${Math.random().toString(36).slice(2, 8)}`;
        const handle: ComposeHandle = {
          id: composeId,
          threadId: undefined,
          isReply: false,
          view: composeView,
          element: composeView.getElement?.() || null,
        };
        this.composeHandles.set(composeId, handle);

        composeView.on?.('destroy', () => {
          this.composeHandles.delete(composeId);
          if (this.activeComposeView === composeView) {
            this.activeComposeView = null;
          }
        });

        void resolveThreadId(composeView as ThreadIdView).then((tid) => {
          if (tid) {
            handle.threadId = tid;
            handle.isReply = true;
          }
        });

        void mapCompose(composeView)
          .then((compose) => {
            if (compose.threadId) {
              handle.threadId = compose.threadId;
              handle.isReply = compose.isReply;
            }
            if (generation === this.generation) {
              emit({ type: 'COMPOSE_OPENED', compose, at: Date.now() });
            }
            composeView.on?.('sent', () => {
              if (generation === this.generation) {
                emit({ type: 'COMPOSE_SENT', compose, at: Date.now() });
              }
            });
          })
          .catch((error) => {
            console.warn('[gi] Failed to map compose view', error);
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
    this.currentThread = null;
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
    if (this.currentThread) {
      return { ...ok('getCurrentThread'), thread: this.currentThread };
    }
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
  async createReplyDraft(threadId: string): Promise<GmailActionResult & { composeHandle?: ComposeHandle }> {
    // 1. Check if a compose handle already exists for this thread's reply
    for (const handle of this.composeHandles.values()) {
      if (handle.threadId === threadId && handle.isReply) {
        return { ...ok('createReplyDraft'), threadId, composeHandle: handle };
      }
    }

    // 2. Trigger reply via fallback (scoped to the thread)
    const fallbackRes = await this.fallback.createReplyDraft(threadId);

    // 3. Check composeHandles
    for (const handle of this.composeHandles.values()) {
      if (handle.threadId === threadId && handle.isReply) {
        return { ...ok('createReplyDraft'), threadId, composeHandle: handle };
      }
    }

    return fallbackRes;
  }

  async insertComposeBody(text: string, target?: ComposeHandle | { threadId?: string }) {
    let targetHandle: ComposeHandle | undefined;

    if (target && 'view' in target && target.view) {
      targetHandle = target as ComposeHandle;
    } else if (target && target.threadId) {
      for (const handle of this.composeHandles.values()) {
        if (handle.threadId === target.threadId && handle.isReply) {
          targetHandle = handle;
          break;
        }
      }
    }

    if (!targetHandle && !target?.threadId && this.composeHandles.size === 1) {
      const only = [...this.composeHandles.values()][0];
      if (only.isReply) targetHandle = only;
    }

    const view = targetHandle?.view as {
      setBodyText?: (text: string) => void;
      insertTextIntoBodyAtCursor?: (text: string) => void;
    } | null;

    if (view) {
      try {
        if (typeof view.setBodyText === 'function') {
          view.setBodyText(text);
          return { ...ok('insertComposeBody'), verified: true, reason: 'Inserted via InboxSDK' };
        }
        if (typeof view.insertTextIntoBodyAtCursor === 'function') {
          view.insertTextIntoBodyAtCursor(text);
          return { ...ok('insertComposeBody'), verified: true, reason: 'Inserted via InboxSDK' };
        }
      } catch {
        /* fall back to DOM */
      }
    }
    return this.fallback.insertComposeBody(text, targetHandle || target);
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
  const messages = await Promise.all(
    messageViews.map(async (message, index) => {
      const isLoaded = typeof message.isLoaded === 'function' ? message.isLoaded() : true;
      let messageId: string | null = null;
      let senderEmail = 'unknown@local';
      let senderName: string | undefined;
      let recipients: Array<{ email: string }> = [];
      let bodyText = '';

      if (isLoaded) {
        messageId = await resolveMessageId(message);
        try {
          const sender = message.getSender?.();
          if (sender?.emailAddress) senderEmail = sender.emailAddress;
          if (sender?.name) senderName = sender.name;
        } catch {
          /* message may not be fully loaded in DOM */
        }
        try {
          recipients = (message.getRecipientEmailAddresses?.() || []).map((email) => ({ email }));
        } catch {
          /* recipient list in flux */
        }
        try {
          bodyText = message.getBodyElement?.()?.textContent?.trim() || '';
        } catch {
          /* body element in flux */
        }
      }

      return {
        messageId: messageId || `${threadId}-msg-${index}`,
        threadId,
        sender: {
          email: senderEmail,
          name: senderName,
        },
        recipients,
        cc: [],
        bodyText,
        attachmentsMetadata: [],
        loaded: isLoaded,
      };
    }),
  );

  return {
    threadId,
    subject,
    route: 'unknown',
    messages,
  };
}

async function mapCompose(view: ComposeViewLike): Promise<ComposeViewState> {
  const threadId = await resolveThreadId(view as ThreadIdView);
  let to: Array<{ email: string; name?: string }> = [];
  let cc: Array<{ email: string; name?: string }> = [];
  let bcc: Array<{ email: string; name?: string }> = [];
  try {
    to = (view.getToRecipients?.() || []).map((recipient) => ({
      email: recipient.emailAddress,
      name: recipient.name,
    }));
  } catch {
    /* compose recipient DOM in flux */
  }
  try {
    cc = (view.getCcRecipients?.() || []).map((recipient) => ({
      email: recipient.emailAddress,
      name: recipient.name,
    }));
  } catch {
    /* compose cc DOM in flux */
  }
  try {
    bcc = (view.getBccRecipients?.() || []).map((recipient) => ({
      email: recipient.emailAddress,
      name: recipient.name,
    }));
  } catch {
    /* compose bcc DOM in flux */
  }
  return {
    composeId: threadId || view.getElement?.()?.id || `compose-${Math.random().toString(36).slice(2, 8)}`,
    to,
    cc,
    bcc,
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
    registerMessageViewHandler?: (cb: (mv: MessageViewLike) => void) => void;
  };
  Compose: {
    registerComposeViewHandler: (cb: (cv: ComposeViewLike) => void) => void;
    openNewComposeView?: () => Promise<ComposeViewLike | null | undefined>;
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
  on?: (event: string, cb: () => void) => void;
};

type MessageViewLike = MessageIdView & {
  isLoaded?: () => boolean;
  getMessageID?: () => string;
  getMessageIDAsync?: () => string | Promise<string>;
  getSender?: () => { name?: string; emailAddress: string };
  getRecipientEmailAddresses?: () => string[];
  getBodyElement?: () => HTMLElement | null;
  getThreadView?: () => ThreadViewLike;
  on?: (event: string, cb: () => void) => void;
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
