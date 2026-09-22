import type { Contact, GmailActionResult, GmailCapabilities } from '@gi/shared';
import { EMPTY_CAPABILITIES } from './capabilities.js';
import {
  logSelectorMiss,
  queryAll,
  queryFirst,
  readAttr,
  SELECTORS,
} from './selectors.js';
import type {
  ComposeViewState,
  CurrentThreadView,
  GmailAdapter,
  MailboxEventHandler,
  ThreadMessageView,
  VisibleThreadRow,
} from './types.js';

function ok(capability: string): GmailActionResult {
  return { success: true, capability };
}

function fail(capability: string, error: string, retryable = true): GmailActionResult {
  return { success: false, capability, error, retryable };
}

function parseContact(text: string, emailAttr?: string | null): Contact {
  const email = emailAttr || text.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] || text.trim();
  const name = emailAttr ? text.trim() : text.replace(/<[^>]+>/, '').trim();
  return { email, name: name !== email ? name : undefined };
}

/**
 * DOM fallback adapter — centralized, debounced observers.
 * Application code must not import selectors directly.
 */
export class DomFallbackAdapter implements GmailAdapter {
  readonly name = 'dom-fallback';
  private handler: MailboxEventHandler | null = null;
  private observer: MutationObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRowFingerprint = '';
  private started = false;

  async detectCapabilities(): Promise<GmailCapabilities> {
    const hasDoc = typeof document !== 'undefined';
    return {
      ...EMPTY_CAPABILITIES,
      domFallbackAvailable: hasDoc,
      // Native label mutation via DOM is unreliable; never claim it.
      persistentNativeLabelMutationAvailable: false,
    };
  }

  async start(handler: MailboxEventHandler): Promise<void> {
    this.handler = handler;
    if (typeof document === 'undefined' || this.started) return;
    this.started = true;
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
    });
    this.scheduleScan();
    handler({
      type: 'capability_changed',
      capabilities: await this.detectCapabilities(),
      at: Date.now(),
    });
  }

  async stop(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.started = false;
    this.handler = null;
  }

  private scheduleScan(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.scanVisible(), 250);
  }

  private scanVisible(): void {
    if (!this.handler || typeof document === 'undefined') return;
    const rows = this.extractRows(document);
    const fp = rows.map((r) => `${r.threadId}:${r.unread}:${r.subject}`).join('|');
    if (fp && fp !== this.lastRowFingerprint) {
      const isNew = this.lastRowFingerprint !== '';
      this.lastRowFingerprint = fp;
      this.handler({ type: 'inbox_observed', rows, at: Date.now() });
      if (isNew && rows[0]) {
        this.handler({ type: 'new_message', row: rows[0], at: Date.now() });
      }
    }
    const thread = this.extractCurrentThread(document);
    if (thread) {
      this.handler({ type: 'thread_opened', thread, at: Date.now() });
    }
    const compose = this.extractCompose(document);
    if (compose) {
      this.handler({ type: 'compose_opened', compose, at: Date.now() });
    }
  }

  extractRows(root: ParentNode): VisibleThreadRow[] {
    const els = queryAll(root, SELECTORS.threadRow);
    if (!els.length) {
      logSelectorMiss('observeInbox.rows', SELECTORS.threadRow);
      return [];
    }
    const rows: VisibleThreadRow[] = [];
    for (const el of els) {
      // Skip our injected UI
      if (el.closest(SELECTORS.injectedUiMark)) continue;
      const threadId = readAttr(el, SELECTORS.threadIdAttr);
      if (!threadId) continue;
      const subjectEl = queryFirst(el, SELECTORS.threadRowSubject);
      const snippetEl = queryFirst(el, SELECTORS.threadRowSnippet);
      const senderEl = queryFirst(el, SELECTORS.threadRowSender);
      const email = senderEl?.getAttribute('email');
      rows.push({
        threadId,
        subject: subjectEl?.textContent?.trim() || '(no subject)',
        snippet: snippetEl?.textContent?.trim() || '',
        participants: senderEl
          ? [parseContact(senderEl.textContent || '', email)]
          : [],
        latestSender: senderEl
          ? parseContact(senderEl.textContent || '', email)
          : undefined,
        unread: el.classList.contains('zE') || el.getAttribute('aria-checked') === 'false',
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
      readAttr(subjectEl, SELECTORS.threadIdAttr) ||
      readAttr(document.body, SELECTORS.threadIdAttr);
    if (!threadId) return null;
    const bodies = queryAll(root, SELECTORS.messageBody);
    const messages: ThreadMessageView[] = bodies.map((b, i) => ({
      messageId: readAttr(b, SELECTORS.messageIdAttr) || `${threadId}-msg-${i}`,
      threadId,
      sender: { email: 'unknown@local' },
      recipients: [],
      cc: [],
      timestamp: new Date().toISOString(),
      bodyText: b.textContent?.trim() || '',
      bodyHtml: undefined,
      attachmentsMetadata: [],
    }));
    return {
      threadId,
      subject: subjectEl.textContent?.trim() || '',
      messages,
      route: 'unknown',
    };
  }

  extractCompose(root: ParentNode): ComposeViewState | null {
    const rootEl = queryFirst(root, SELECTORS.composeRoot);
    if (!rootEl) return null;
    const body = queryFirst(rootEl, SELECTORS.composeBody);
    const subject = queryFirst(rootEl, SELECTORS.composeSubject) as HTMLInputElement | null;
    const to = queryFirst(rootEl, SELECTORS.composeTo) as HTMLInputElement | null;
    return {
      composeId: rootEl.getAttribute('id') || `compose-${Date.now()}`,
      to: to?.value ? [{ email: to.value }] : [],
      cc: [],
      bcc: [],
      subject: subject?.value || '',
      bodyText: body?.textContent || '',
      isReply: Boolean(rootEl.querySelector('[aria-label*="Reply" i]')),
    };
  }

  async observeInbox() {
    if (typeof document === 'undefined') {
      return { ...fail('observeInbox', 'no document'), rows: [] };
    }
    const rows = this.extractRows(document);
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
    if (typeof document === 'undefined') {
      return fail('getCurrentThread', 'no document');
    }
    const thread = this.extractCurrentThread(document);
    if (!thread) return fail('getCurrentThread', 'thread not visible', false);
    return { ...ok('getCurrentThread'), thread };
  }

  async getCurrentCompose() {
    if (typeof document === 'undefined') {
      return fail('getCurrentCompose', 'no document');
    }
    const compose = this.extractCompose(document);
    if (!compose) return fail('getCurrentCompose', 'compose not open', false);
    return { ...ok('getCurrentCompose'), compose };
  }

  async openThread(threadId: string) {
    if (typeof document === 'undefined') return fail('openThread', 'no document');
    const rows = queryAll(document, SELECTORS.threadRow);
    const match = rows.find((r) => readAttr(r, SELECTORS.threadIdAttr) === threadId);
    if (!match) return fail('openThread', 'row not found', true);
    (match as HTMLElement).click();
    return ok('openThread');
  }

  async archiveThread(_threadId: string) {
    return this.clickToolbar(SELECTORS.archiveButton, 'archiveThread');
  }

  async markRead(_threadId: string) {
    return this.clickToolbar(SELECTORS.markReadButton, 'markRead');
  }

  async markUnread(_threadId: string) {
    return this.clickToolbar(SELECTORS.markUnreadButton, 'markUnread');
  }

  async starThread(_threadId: string) {
    return this.clickToolbar(SELECTORS.starButton, 'starThread');
  }

  async createReplyDraft(_threadId: string) {
    return this.clickToolbar(SELECTORS.replyButton, 'createReplyDraft');
  }

  async insertComposeBody(text: string) {
    if (typeof document === 'undefined') return fail('insertComposeBody', 'no document');
    const body = queryFirst(document, SELECTORS.composeBody) as HTMLElement | null;
    if (!body) {
      logSelectorMiss('insertComposeBody', SELECTORS.composeBody);
      return fail('insertComposeBody', 'compose body not found', true);
    }
    body.focus();
    // Prefer execCommand for Gmail editable; fall back to textContent
    const inserted = document.execCommand?.('insertText', false, text);
    if (!inserted) {
      body.textContent = (body.textContent || '') + text;
      body.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return ok('insertComposeBody');
  }

  async navigateToSearch(query: string) {
    if (typeof document === 'undefined') return fail('navigateToSearch', 'no document');
    const box = queryFirst(document, SELECTORS.searchBox) as HTMLInputElement | null;
    if (!box) {
      // URL hash fallback — still Gmail web UI, not private RPC
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

  private clickToolbar(sels: readonly string[], capability: string): GmailActionResult {
    if (typeof document === 'undefined') return fail(capability, 'no document');
    const btn = queryFirst(document, sels) as HTMLElement | null;
    if (!btn) {
      logSelectorMiss(capability, sels);
      return fail(capability, 'control not found', true);
    }
    btn.click();
    return ok(capability);
  }
}
