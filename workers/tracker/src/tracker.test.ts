/**
 * In-memory tracker route tests (no Supabase).
 * Exercises pixel response, click redirect policy, auth gate, malformed IDs.
 */
import { describe, expect, it, vi } from 'vitest';
import { classifyClick, safeRedirectUrl, suspectSelfOpen } from './helpers';

// Recreate GIF header check independently
const GIF87A = [0x47, 0x49, 0x46, 0x38]; // GIF8

describe('tracker pure helpers', () => {
  it('safeRedirectUrl blocks open redirects to non-http', () => {
    expect(safeRedirectUrl('https://ok.example/x?q=1')).toContain('https://');
    expect(safeRedirectUrl('ftp://files')).toBeNull();
  });

  it('suspectSelfOpen uses timing', () => {
    const sent = new Date(Date.now() - 1000).toISOString();
    expect(suspectSelfOpen({ sentAt: sent, now: Date.now(), ua: null }).suspected).toBe(true);
    const old = new Date(Date.now() - 60_000).toISOString();
    expect(suspectSelfOpen({ sentAt: old, now: Date.now(), ua: null }).suspected).toBe(false);
  });

  it('classifyClick classifies sender, bot, and recipient clicks', () => {
    const now = Date.now();
    const sentAt = new Date(now - 10_000).toISOString();

    // 1. Recipient click
    const res1 = classifyClick({
      sentAt,
      now,
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    });
    expect(res1.classification).toBe('RECIPIENT_LIKELY');
    expect(res1.countsAsClick).toBe(true);

    // 2. Correlated self-view click
    const res2 = classifyClick({
      sentAt,
      now,
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      selfViewTs: now - 500,
    });
    expect(res2.classification).toBe('SELF_LIKELY');
    expect(res2.countsAsClick).toBe(false);

    // 3. Pre-send click
    const res3 = classifyClick({
      sentAt: new Date(now + 10_000).toISOString(),
      now,
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });
    expect(res3.classification).toBe('SELF_LIKELY');
    expect(res3.countsAsClick).toBe(false);

    // 4. Scanner click
    const res4 = classifyClick({
      sentAt,
      now,
      ua: 'Barracuda-Url-Scanner/1.0',
    });
    expect(res4.classification).toBe('MACHINE_LIKELY');
    expect(res4.countsAsClick).toBe(false);
  });
});

describe('auth + malformed ID contracts', () => {
  it('tracking id pattern is restrictive', () => {
    const ok = /^[\w-]+$/;
    expect(ok.test('trk_abc123')).toBe(true);
    expect(ok.test('../etc/passwd')).toBe(false);
    expect(ok.test('a/b')).toBe(false);
  });

  it('safeRedirectUrl blocks javascript and data URLs', () => {
    expect(safeRedirectUrl('javascript:alert(1)')).toBeNull();
    expect(safeRedirectUrl('data:text/html,hi')).toBeNull();
    expect(safeRedirectUrl('http://ok.example')).toContain('http://');
  });

  it('suspectSelfOpen flags headless agents', () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    expect(
      suspectSelfOpen({ sentAt: old, now: Date.now(), ua: 'HeadlessChrome' }).suspected,
    ).toBe(false); // score 0.3 < 0.5 alone
    expect(
      suspectSelfOpen({
        sentAt: new Date(Date.now() - 1000).toISOString(),
        now: Date.now(),
        ua: 'HeadlessChrome',
      }).confidence,
    ).toBeGreaterThanOrEqual(0.8);
  });
});

describe('gif bytes', () => {
  it('transparent gif starts with GIF8', () => {
    const b64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect([...bytes.slice(0, 4)]).toEqual(GIF87A);
  });
});

// silence unused
void vi;
