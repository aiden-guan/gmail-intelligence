/**
 * ALL direct Gmail DOM selectors live here only.
 * Prefer InboxSDK semantics and accessibility attributes over brittle CSS classes.
 * Selectors are ordered by stability preference.
 */
export const SELECTORS = {
  /** Thread list rows — prefer role + structure over class hashes */
  threadRow: [
    'tr.zA',
    'div[role="main"] tr[jscontroller]',
    'div[role="listitem"][data-legacy-thread-id]',
    '[data-thread-id]',
  ],
  threadRowSubject: ['.bog', '.bqe', '[data-legacy-thread-id] span[email]', '.y6 span'],
  threadRowSnippet: ['.y2', '.Zt'],
  threadRowSender: ['.yW span[email]', '.yP', '.zF', 'span[email]'],
  threadIdAttr: ['data-legacy-thread-id', 'data-thread-perm-id', 'data-thread-id'],
  messageIdAttr: ['data-legacy-message-id', 'data-message-id'],
  openThread: ['div[role="main"] h2.hP', 'h2[data-thread-perm-id]', '[data-legacy-thread-id].nH'],
  messageBody: ['.a3s.aiL', '.a3s', 'div[data-message-id] .a3s', '[role="listitem"] .ii'],
  composeRoot: [
    'div[role="dialog"][aria-label*="compose" i]',
    '.M9',
    'div.AD',
    'form[method="POST"].bAs',
  ],
  composeBody: ['div[aria-label="Message Body"]', 'div[g_editable="true"]', '.Am.Al.editable'],
  composeTo: ['textarea[name="to"]', 'input[name="to"]', '[aria-label="To recipients"]'],
  composeSubject: ['input[name="subjectbox"]', 'input[aria-label="Subject"]'],
  archiveButton: [
    'div[aria-label="Archive"]',
    'div[data-tooltip="Archive"]',
    'div[aria-label*="Archive" i]',
  ],
  markReadButton: ['div[aria-label="Mark as read"]', 'div[data-tooltip="Mark as read"]'],
  markUnreadButton: ['div[aria-label="Mark as unread"]', 'div[data-tooltip="Mark as unread"]'],
  starButton: ['div[aria-label="Not starred"]', 'span[aria-label="Not starred"]', '.T-KT'],
  replyButton: ['div[aria-label="Reply"]', 'div[data-tooltip="Reply"]', 'span[role="link"][aria-label="Reply"]'],
  searchBox: ['input[aria-label="Search mail"]', 'input[name="q"]', 'form[role="search"] input'],
  inboxNav: ['a[aria-label="Inbox"]', 'a[href*="#inbox"]'],
  unsubscribeLink: ['a[href*="unsubscribe" i]', 'a[aria-label*="Unsubscribe" i]'],
  injectedUiMark: '[data-gi-ui="1"]',
} as const;

export type SelectorKey = keyof typeof SELECTORS;

export function queryFirst(root: ParentNode, keys: readonly string[]): Element | null {
  for (const sel of keys) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {
      // invalid selector in this environment — continue
    }
  }
  return null;
}

export function queryAll(root: ParentNode, keys: readonly string[]): Element[] {
  for (const sel of keys) {
    try {
      const list = [...root.querySelectorAll(sel)];
      if (list.length) return list;
    } catch {
      // continue
    }
  }
  return [];
}

export function readAttr(el: Element, attrs: readonly string[]): string | undefined {
  for (const a of attrs) {
    const v = el.getAttribute(a);
    if (v) return v;
  }
  // walk up a few levels for thread id
  let cur: Element | null = el;
  for (let i = 0; i < 6 && cur; i++) {
    for (const a of attrs) {
      const v = cur.getAttribute(a);
      if (v) return v;
    }
    cur = cur.parentElement;
  }
  return undefined;
}

export function logSelectorMiss(capability: string, keys: readonly string[]): void {
  // Diagnostic only — never crash
  console.warn(`[gi/gmail] selector miss for ${capability}:`, keys.slice(0, 3).join(', '));
}
