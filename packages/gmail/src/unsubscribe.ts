import { queryAll, SELECTORS } from './selectors.js';

export type UnsubscribeCandidate = {
  href: string;
  source: 'visible_link' | 'list_unsubscribe_header';
};

/**
 * Detect visible unsubscribe affordances. NEVER auto-unsubscribe.
 * List-Unsubscribe header data is only used when Gmail.js/bridge supplies it.
 */
export function findUnsubscribeLinks(
  root: ParentNode,
  listUnsubscribeHeader?: string | null,
): UnsubscribeCandidate[] {
  const found: UnsubscribeCandidate[] = [];
  for (const el of queryAll(root, SELECTORS.unsubscribeLink)) {
    const href = (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      found.push({ href, source: 'visible_link' });
    }
  }
  if (listUnsubscribeHeader) {
    const urls = [...listUnsubscribeHeader.matchAll(/<(https?:\/\/[^>]+)>/gi)].map((m) => m[1]!);
    for (const href of urls) {
      found.push({ href, source: 'list_unsubscribe_header' });
    }
  }
  // de-dupe
  const seen = new Set<string>();
  return found.filter((c) => {
    if (seen.has(c.href)) return false;
    seen.add(c.href);
    return true;
  });
}
