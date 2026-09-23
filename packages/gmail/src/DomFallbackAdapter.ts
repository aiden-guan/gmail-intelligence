import type { Contact, GmailActionResult, GmailCapabilities } from '@gi/shared';
import { EMPTY_CAPABILITIES } from './capabilities.js';
import {
  findArchiveButton,
  findComposeBody,
  findComposeRoot,
  findMain,
  findNotice,
  findSearchBox,
  findThreadRows,
  getThreadIdFromElement,
  logSelectorMiss,
  queryAll,
  queryFirst,
  readAttr,
  SELECTORS,
  selectorDiagnostics,
} from './selectors.js';
import type {
  ComposeViewState,
  CurrentThreadView,
  GmailAdapter,
  MailboxEventHandler,
  ThreadMessageView,
  ThreadRoute,
  VisibleThreadRow,
} from './types.js';

function ok(capability: string, extra: Partial<GmailActionResult> = {}): GmailActionResult {
  return { success: true, capability, action: capability, verified: false, ...extra };
}

function fail(capability: string, error: string, retryable = true): GmailActionResult {
  return { success: false, capability, action: capability, error, reason: error, retryable, verified: false };
}

function parseContact(text: string, emailAttr?: string | null): Contact {
  const email = emailAttr || text.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] || text.trim();
  const name = emailAttr ? text.trim() : text.replace(/<[^>]+>/, '').trim();
  return { email, name: name !== email ? name : undefined };
}

function routeFromLocation(): ThreadRoute {
  const hash = typeof location !== 'undefined' ? location.hash.toLowerCase() : '';
  if (hash.includes('sent')) return 'sent';
  if (hash.includes('draft')) return 'drafts';
  if (hash.includes('search')) return 'search';
  if (hash.includes('star')) return 'starred';
  if (hash.includes('spam')) return 'spam';
  if (hash.includes('trash')) return 'trash';
  if (hash.includes('inbox') || hash === '' || hash === '#') return 'inbox';
  return 'unknown';
}

function stableComposeId(el: HTMLElement): string {
  const existing = el.getAttribute('data-gi-compose-id');
  if (existing) return existing;
  const id = el.id || `compose-${Math.random().toString(36).slice(2, 10)}`;
  el.setAttribute('data-gi-compose-id', id);
  return id;
}

/**
 * DOM fallback adapter — one debounced observer, centralized selectors.
 * Row-list changes are VISIBLE_ROWS_CHANGED. They are not new mail.
 */
export class DomFallbackAdapter implements GmailAdapter {
  readonly name = 'dom-fallback';
  private handler: MailboxEventHandler | null = null;
  private observer: MutationObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRowFingerprint = '';
  private lastThreadKey = '';
  private lastThreadId = '';
  private lastComposeId = '';
  private lastRoute = '';
  private started = false;

  constructor(private readonly opts: { debounceMs?: number } = {}) {}

  async detectCapabilities(): Promise<GmailCapabilities> {
    const hasDoc = typeof document !== 'undefined';
    const diagnostics = hasDoc ? selectorDiagnostics(document) : [];
    const listExpected = typeof location !== 'undefined' && /#(inbox|search|sent|starred)/i.test(location.hash);
    const rowsFound = diagnostics.find((item) => item.key === 'threadRow')?.found;
    const domHealthy = !hasDoc || !listExpected || Boolean(rowsFound) || Boolean(diagnostics.find((item) => item.key === 'openThread')?.found);
    return {
      ...EMPTY_CAPABILITIES,
      domFallbackAvailable: hasDoc && domHealthy,
      persistentNativeLabelMutationAvailable: false,
    };
  }

  async start(handler: MailboxEventHandler): Promise<void> {
    if (this.started) return;
    this.handler = handler;
    if (typeof document === 'undefined') return;
    this.started = true;
    this.observer = new MutationObserver((mutations) => {
      const external = mutations.some((mutation) => {
        const node = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return !node?.closest?.('[data-gi-ui], .gi-track-slot, .gi-cat-chip, #gi-thread-panel, #gi-track-style');
      });
      if (external) this.scheduleScan();
    });
    const root = document.body ?? document.documentElement;
    this.observer.observe(root, { childList: true, subtree: true });
    this.scheduleScan();
    this.emitRoute();
    handler({
      type: 'CAPABILITY_CHANGED',
      capabilities: await this.detectCapabilities(),
      at: Date.now(),
    });
  }

  async stop(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.started = false;
    this.handler = null;
    this.lastRowFingerprint = '';
    this.lastThreadKey = '';
    this.lastThreadId = '';
    this.lastComposeId = '';
    this.lastRoute = '';
  }

  isStarted(): boolean {
    return this.started;
  }

  private scheduleScan(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.scanVisible(), this.opts.debounceMs ?? 250);
  }

  private emit(event: Parameters<MailboxEventHandler>[0]): void {
    this.handler?.(event);
  }

  private emitRoute(): void {
    const route = routeFromLocation();
    const query = typeof location !== 'undefined' ? location.hash : '';
    if (route === this.lastRoute && this.lastRoute) return;
    this.lastRoute = route;
    this.emit({ type: 'ROUTE_CHANGED', route, query, at: Date.now() });
  }

  private scanVisible(): void {
    if (!this.handler || typeof document === 'undefined') return;
    this.emitRoute();
    const scope = findMain(document) || document;
    const rows = this.extractRows(scope);
    const fp = rows
      .map((row) => `${row.threadId}:${row.unread}:${row.subject}:${row.snippet}:${row.latestSender?.email || ''}`)
      .join('|');
    if (fp !== this.lastRowFingerprint) {
      this.lastRowFingerprint = fp;
      this.emit({ type: 'VISIBLE_ROWS_CHANGED', rows, at: Date.now() });
    }
    const thread = this.extractCurrentThread(document);
    if (thread) {
      const key = `${thread.threadId}|${thread.messages.map((message) => `${message.messageId}:${message.bodyText.length}`).join(',')}`;
      if (key !== this.lastThreadKey) {
        const updated = this.lastThreadId === thread.threadId && this.lastThreadKey !== '';
        this.lastThreadKey = key;
        this.lastThreadId = thread.threadId;
        this.emit({
          type: updated ? 'THREAD_DATA_UPDATED' : 'THREAD_OPENED',
          thread,
          at: Date.now(),
        });
      }
    }
    const compose = this.extractCompose(document);
    if (compose && compose.composeId !== this.lastComposeId) {
      this.lastComposeId = compose.composeId;
      this.emit({ type: 'COMPOSE_OPENED', compose, at: Date.now() });
    }
    if (!compose) this.lastComposeId = '';
  }

  extractRows(root: ParentNode): VisibleThreadRow[] {
    const els = findThreadRows(root);
    if (!els.length) {
      logSelectorMiss('observeInbox.rows', SELECTORS.threadRow);
      return [];
    }
    const rows: VisibleThreadRow[] = [];
    for (const el of els) {
      if (el.closest(SELECTORS.injectedUiMark)) continue;
      const threadId = getThreadIdFromElement(el);
      if (!threadId) continue;
      const subjectEl = queryFirst(el, SELECTORS.threadRowSubject);
      const snippetEl = queryFirst(el, SELECTORS.threadRowSnippet);
      const senderEl = queryFirst(el, SELECTORS.threadRowSender);
      const email = senderEl?.getAttribute('email');
      rows.push({
        threadId,
        subject: subjectEl?.textContent?.trim() || '(no subject)',
        snippet: snippetEl?.textContent?.trim() || '',
        participants: senderEl ? [parseContact(senderEl.textContent || '', email)] : [],
        latestSender: senderEl ? parseContact(senderEl.textContent || '', email) : undefined,
        unread: el.classList.contains('zE'),
        starred: Boolean(el.querySelector('[aria-label="Starred"]')),
        labels: [],
      });
    }
    return rows;
  }

  extractCurrentThread(root: ParentNode): CurrentThreadView | null {
    const subjectEl = queryFirst(root, SELECTORS.openThread);
    if (!subjectEl) return null;
    const threadId =
      getThreadIdFromElement(subjectEl) ||
      (typeof document !== 'undefined' ? getThreadIdFromElement(document.body) : undefined);
    if (!threadId) return null;
    const bodies = queryAll(root, SELECTORS.messageBody);
    const messages: ThreadMessageView[] = bodies.map((body, index) => ({
      messageId: readAttr(body, SELECTORS.messageIdAttr) || `${threadId}-msg-${index}`,
      threadId,
      sender: { email: 'unknown@local' },
      recipients: [],
      cc: [],
      bodyText: body.textContent?.trim() || '',
      bodyHtml: undefined,
      attachmentsMetadata: [],
    }));
    return {
      threadId,
      subject: subjectEl.textContent?.trim() || '',
      messages,
      route: routeFromLocation(),
    };
  }

  extractCompose(root: ParentNode): ComposeViewState | null {
    const rootEl = findComposeRoot(root);
    if (!rootEl) return null;
    const body = findComposeBody(rootEl);
    const subject = queryFirst(rootEl, SELECTORS.composeSubject) as HTMLInputElement | null;
    const to = queryFirst(rootEl, SELECTORS.composeTo) as HTMLInputElement | null;
    const label = (rootEl.getAttribute('aria-label') || '').toLowerCase();
    return {
      composeId: stableComposeId(rootEl),
      to: to?.value ? [{ email: to.value }] : [],
      cc: [],
      bcc: [],
      subject: subject?.value || '',
      bodyText: body?.textContent || '',
      isReply: label.includes('reply') || label.includes('forward'),
    };
  }

  async observeInbox() {
    if (typeof document === 'undefined') return { ...fail('observeInbox', 'no document'), rows: [] };
    const rows = this.extractRows(findMain(document) || document);
    return { ...ok('observeInbox'), rows };
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
    return this.observeInbox();
  }

  async getCurrentThread() {
    if (typeof document === 'undefined') return fail('getCurrentThread', 'no document');
    const thread = this.extractCurrentThread(document);
    if (!thread) return fail('getCurrentThread', 'thread not visible', false);
    return { ...ok('getCurrentThread'), thread };
  }

  async getCurrentCompose() {
    if (typeof document === 'undefined') return fail('getCurrentCompose', 'no document');
    const compose = this.extractCompose(document);
    if (!compose) return fail('getCurrentCompose', 'compose not open', false);
    return { ...ok('getCurrentCompose'), compose };
  }

  async openThread(threadId: string) {
    if (typeof document === 'undefined') return fail('openThread', 'no document');
    const match = findThreadRows(document).find((row) => getThreadIdFromElement(row) === threadId);
    if (!match) return fail('openThread', 'row not found', true);
    match.click();
    return { ...ok('openThread', { threadId }), verified: false };
  }

  async archiveThread(threadId: string) {
    const result = this.clickToolbar(SELECTORS.archiveButton, 'archiveThread');
    return { ...result, threadId };
  }

  async markRead(threadId: string) {
    return { ...this.clickToolbar(SELECTORS.markReadButton, 'markRead'), threadId };
  }

  async markUnread(threadId: string) {
    return { ...this.clickToolbar(SELECTORS.markUnreadButton, 'markUnread'), threadId };
  }

  async starThread(threadId: string) {
    return { ...this.clickToolbar(SELECTORS.starButton, 'starThread'), threadId };
  }

  async createReplyDraft(threadId: string) {
    return { ...this.clickToolbar(SELECTORS.replyButton, 'createReplyDraft'), threadId };
  }

  async insertComposeBody(text: string) {
    if (typeof document === 'undefined') return fail('insertComposeBody', 'no document');
    const body = findComposeBody(document);
    if (!body) {
      logSelectorMiss('insertComposeBody', SELECTORS.composeBody);
      return fail('insertComposeBody', 'compose body not found', true);
    }
    body.focus();
    const inserted = document.execCommand?.('insertText', false, text);
    if (!inserted) {
      body.textContent = (body.textContent || '') + text;
      body.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    const verified = (body.textContent || '').includes(text.slice(0, 80));
    return {
      ...ok('insertComposeBody'),
      verified,
      reason: verified ? 'Compose body contains the text' : 'Text was not found after insert',
    };
  }

  async navigateToSearch(query: string) {
    if (typeof document === 'undefined') return fail('navigateToSearch', 'no document');
    const box = findSearchBox(document);
    if (!box) {
      location.hash = `#search/${encodeURIComponent(query)}`;
      return ok('navigateToSearch');
    }
    box.focus();
    box.value = query;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const form = box.closest('form');
    if (form) form.requestSubmit?.();
    else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return ok('navigateToSearch');
  }

  async navigateToInbox() {
    if (typeof document === 'undefined') return fail('navigateToInbox', 'no document');
    const link = queryFirst(document, SELECTORS.inboxNav) as HTMLAnchorElement | null;
    if (link) {
      link.click();
      return ok('navigateToInbox');
    }
    location.hash = '#inbox';
    return ok('navigateToInbox');
  }

  readNotice(): string | null {
    if (typeof document === 'undefined') return null;
    return findNotice(document);
  }

  private clickToolbar(sels: readonly string[], capability: string): GmailActionResult {
    if (typeof document === 'undefined') return fail(capability, 'no document');
    const btn = (capability === 'archiveThread' ? findArchiveButton(document) : queryFirst(document, sels)) as HTMLElement | null;
    if (!btn) {
      logSelectorMiss(capability, sels);
      return fail(capability, 'control not found', true);
    }
    btn.click();
    return ok(capability);
  }
}
