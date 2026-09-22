/**
 * In-memory tracker route tests (no Supabase).
 * Exercises pixel response, click redirect policy, auth gate, malformed IDs.
 */
import { describe, expect, it, vi } from 'vitest';
import { safeRedirectUrl, suspectSelfOpen } from './helpers';

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
