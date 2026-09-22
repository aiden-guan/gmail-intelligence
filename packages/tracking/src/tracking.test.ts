import { describe, expect, it } from 'vitest';
import {
  shouldRewriteLink,
  buildTrackingPixelHtml,
  formatSentTrackingBadge,
  isLikelySelfOpen,
  rewriteHtmlLinks,
} from '@gi/tracking';

// Local copies of worker helpers to avoid cross-package TS project refs in tests
function safeRedirectUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}
function suspectSelfOpen(opts: {
  sentAt: string | null;
  now: number;
  ua: string | null;
}): { suspected: boolean; confidence: number } {
  let score = 0;
  if (opts.sentAt) {
    const delta = opts.now - Date.parse(opts.sentAt);
    if (delta >= 0 && delta < 5000) score += 0.5;
  }
  if (opts.ua && /Headless|Lighthouse/i.test(opts.ua)) score += 0.3;
  return { suspected: score >= 0.5, confidence: Math.min(1, score) };
}

describe('link rewriting policy', () => {
  it('only rewrites http(s)', () => {
    expect(shouldRewriteLink('https://example.com/a')).toBe(true);
    expect(shouldRewriteLink('http://example.com/a')).toBe(true);
    expect(shouldRewriteLink('mailto:a@b.com')).toBe(false);
    expect(shouldRewriteLink('tel:+123')).toBe(false);
    expect(shouldRewriteLink('javascript:alert(1)')).toBe(false);
    expect(shouldRewriteLink('#section')).toBe(false);
    expect(shouldRewriteLink('https://mail.google.com/mail/u/0/#inbox')).toBe(false);
  });

  it('rewrites html hrefs via map', () => {
    const map = new Map([['https://example.com', 'https://tracker/c/1']]);
    const html = rewriteHtmlLinks('<a href="https://example.com">x</a><a href="mailto:a@b.com">y</a>', map);
    expect(html).toContain('https://tracker/c/1');
    expect(html).toContain('mailto:a@b.com');
  });
});

describe('pixel + badges', () => {
  it('builds hidden pixel', () => {
    const html = buildTrackingPixelHtml('https://tracker/open/abc');
    expect(html).toContain('src="https://tracker/open/abc"');
    expect(html).toContain('width="1"');
  });

  it('formats sent badges with open-detected wording', () => {
    expect(formatSentTrackingBadge({ open_count: 0, click_count: 0 })).toMatch(/no open detected/);
    expect(formatSentTrackingBadge({ open_count: 1, click_count: 0 })).toMatch(/open detected/);
    expect(formatSentTrackingBadge({ open_count: 3, click_count: 1 })).toMatch(/Link 1/);
  });
});

describe('self-open filtering', () => {
  it('flags immediate opens', () => {
    const now = Date.now();
    expect(
      isLikelySelfOpen({ eventTs: now + 1000, sentAt: now, senderActiveRecently: true }).suspected,
    ).toBe(true);
  });

  it('worker helper matches', () => {
    const r = suspectSelfOpen({
      sentAt: new Date().toISOString(),
      now: Date.now() + 1000,
      ua: 'Mozilla',
    });
    expect(r.suspected).toBe(true);
  });
});

describe('safe redirects', () => {
  it('allows only http(s)', () => {
    expect(safeRedirectUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(safeRedirectUrl('javascript:alert(1)')).toBeNull();
    expect(safeRedirectUrl('mailto:a@b.com')).toBeNull();
  });
});

describe('bad ids / auth shapes', () => {
  it('rejects empty destinations', () => {
    expect(safeRedirectUrl('')).toBeNull();
    expect(safeRedirectUrl('not a url')).toBeNull();
  });
});
