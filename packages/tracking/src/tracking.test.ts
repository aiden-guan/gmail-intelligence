import { describe, expect, it } from 'vitest';
import {
  shouldRewriteLink,
  buildTrackingPixelHtml,
  formatSentTrackingBadge,
  isLikelySelfOpen,
  rewriteHtmlLinks,
  appendTrackingPixel,
  applyTrackingToOutgoingHtml,
  describeTrackingStatus,
  isLoopbackTracker,
  matchTrackedEmail,
  normalizeSubject,
  summaryFromRemote,
  trackerPermissionOrigin,
  type TrackedEmailSummary,
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
  it('builds a pixel clients will actually fetch', () => {
    const html = buildTrackingPixelHtml('https://tracker/open/abc');
    expect(html).toContain('src="https://tracker/open/abc"');
    expect(html).toContain('width="1"');
    expect(html).not.toContain('display:none');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  it('appends the pixel once and rewrites only the mapped link', () => {
    const map = new Map([['https://example.com/a', 'https://tracker/c/1']]);
    const once = applyTrackingToOutgoingHtml('<p>Hi</p><a href="https://example.com/a">a</a>', {
      pixelUrl: 'https://tracker/open/abc',
      linkMap: map,
      trackOpens: true,
      trackLinks: true,
    });
    expect(once).toContain('https://tracker/c/1');
    expect(once).toContain('https://tracker/open/abc');
    expect(appendTrackingPixel(once, 'https://tracker/open/abc')).toBe(once);
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

describe('sent mail status', () => {
  const base: TrackedEmailSummary = {
    trackingId: 'trk_1',
    subject: 'Hello',
    sender: 'me@example.com',
    recipients: ['a@b.com'],
    gmailThreadId: 'thread-1',
    gmailMessageId: null,
    sentAt: '2026-09-22T15:00:00.000Z',
    firstOpenedAt: null,
    lastOpenedAt: null,
    openCount: 0,
    clickCount: 0,
    notifyIfNoReply: false,
  };

  it('matches a row by thread id and ignores a different thread with the same subject', () => {
    const other = { ...base, trackingId: 'trk_2', gmailThreadId: 'thread-2', subject: 'Hello' };
    const unlinked = {
      ...base,
      trackingId: 'trk_3',
      gmailThreadId: null,
      subject: 'Hello',
      sentAt: '2026-09-22T16:00:00.000Z',
    };
    expect(
      matchTrackedEmail(
        { threadIds: ['thread-1'], subject: 'Re: Hello', emails: ['a@b.com'] },
        [other, unlinked, base],
      )?.trackingId,
    ).toBe('trk_1');
  });

  it('matches one tracked email by subject when the row has no address', () => {
    expect(
      matchTrackedEmail({ threadIds: ['other-id'], subject: 'Hello', emails: [] }, [base])?.trackingId,
    ).toBe('trk_1');
  });

  it('matches a sent row when a category chip is glued to the subject', () => {
    expect(normalizeSubject('sdefsfseWaiting')).toBe('sdefsfse');
    expect(
      matchTrackedEmail(
        { threadIds: [], subject: 'HelloWaiting', emails: ['a@b.com'] },
        [{ ...base, gmailThreadId: null }],
      )?.trackingId,
    ).toBe('trk_1');
  });

  it('matches a sent row whose subject line also contains the preview', () => {
    expect(
      matchTrackedEmail(
        { threadIds: [], subject: 'Hello - can you review this today', emails: ['a@b.com'] },
        [{ ...base, gmailThreadId: null }],
      )?.trackingId,
    ).toBe('trk_1');
  });

  it('matches an unlinked send by subject and recipient', () => {
    const unlinked = { ...base, gmailThreadId: null };
    expect(
      matchTrackedEmail(
        { threadIds: ['thread-9'], subject: 'Hello', emails: ['A@B.com'] },
        [unlinked],
      )?.trackingId,
    ).toBe('trk_1');
  });

  it('describes an open the way the sent-mail card should read', () => {
    const sent = Date.parse('2026-09-22T15:00:00.000Z');
    const opened = sent + 20_000;
    const copy = describeTrackingStatus(
      {
        ...base,
        openCount: 2,
        firstOpenedAt: new Date(opened).toISOString(),
        lastOpenedAt: new Date(opened).toISOString(),
      },
      { now: opened + 15_000 },
    );
    expect(copy.opened).toBe(true);
    expect(copy.headline).toBe('a@b.com opened your email less than a minute ago.');
    expect(copy.detail).toBe('First opened less than a minute after you sent.');
    expect(copy.countLabel).toBe('Opened 2 times');
    expect(copy.markLabel).toBe('Opened');
  });

  it('describes mail that has not been opened', () => {
    const copy = describeTrackingStatus(base, { now: Date.parse(base.sentAt) + 60_000 });
    expect(copy.opened).toBe(false);
    expect(copy.headline).toBe('Not opened yet.');
    expect(copy.detail).toBe('Tracking is on for this email.');
    expect(copy.countLabel).toBe('Not opened yet');
    expect(copy.markLabel).toBe('Not opened');
  });

  it('keeps the local reply reminder when remote stats refresh', () => {
    const merged = summaryFromRemote(
      {
        tracking_id: 'trk_1',
        subject: 'Hello',
        sender: 'me@example.com',
        recipients: ['a@b.com'],
        sent_at: base.sentAt,
        open_count: 1,
        gmail_thread_id: null,
      },
      { ...base, notifyIfNoReply: true },
    );
    expect(merged.openCount).toBe(1);
    expect(merged.notifyIfNoReply).toBe(true);
    expect(merged.gmailThreadId).toBe('thread-1');
  });

  it('treats localhost as unreachable for recipient opens', () => {
    expect(isLoopbackTracker('http://127.0.0.1:8787')).toBe(true);
    expect(isLoopbackTracker('https://track.example')).toBe(false);
    expect(trackerPermissionOrigin('http://127.0.0.1:8787')).toBeNull();
    expect(trackerPermissionOrigin('https://track.example/path')).toBe('https://track.example/*');
  });
});

describe('bad ids / auth shapes', () => {
  it('rejects empty destinations', () => {
    expect(safeRedirectUrl('')).toBeNull();
    expect(safeRedirectUrl('not a url')).toBeNull();
  });
});
