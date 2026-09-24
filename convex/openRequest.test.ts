import { describe, expect, it } from 'vitest';
import {
  classifyOpenEvent,
  deriveTrackingStats,
  isSelfViewCorrelated,
  normalizeGmailId,
  publicTrackerOrigin,
  trackingIdFromUrl,
} from './openRequest';

describe('open pixel urls', () => {
  it('reads a tracking id from a gif path and an extensionless path', () => {
    expect(trackingIdFromUrl('https://eagle.convex.site/open/trk_abc123.gif')).toBe('trk_abc123');
    expect(trackingIdFromUrl('https://eagle.convex.site/open/trk_abc123')).toBe('trk_abc123');
    expect(trackingIdFromUrl('https://eagle.convex.site/open/trk_abc123.gif?cache=1')).toBe('trk_abc123');
  });

  it('does not count a pixel fetch that happens before the message is sent', () => {
    const now = Date.parse('2026-09-23T12:00:00.000Z');
    const browserUA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(classifyOpenEvent({ eventTs: now, sentAt: null, userAgent: browserUA })).toMatchObject({
      classification: 'SELF_LIKELY',
      countsAsOpen: false,
    });
    expect(
      classifyOpenEvent({ eventTs: now, sentAt: now + 5_000, userAgent: browserUA }).countsAsOpen,
    ).toBe(false);
    expect(
      classifyOpenEvent({ eventTs: now + 60_000, sentAt: now, userAgent: browserUA }),
    ).toMatchObject({ classification: 'RECIPIENT_LIKELY', countsAsOpen: true });
  });

  it('ignores a url that is not an open pixel', () => {
    expect(trackingIdFromUrl('https://eagle.convex.site/health')).toBeNull();
  });

  it('never puts the convex cloud host in a pixel url', () => {
    expect(publicTrackerOrigin(undefined, 'https://eagle.convex.cloud/api/emails')).toBe(
      'https://eagle.convex.site',
    );
    expect(publicTrackerOrigin('https://eagle.convex.site', 'https://eagle.convex.cloud/api/emails')).toBe(
      'https://eagle.convex.site',
    );
  });

  it('classifies google image proxy as PROXY_LIKELY and does not count as open', () => {
    const sentAt = Date.parse('2026-09-23T12:00:00.000Z');
    const eventTs = sentAt + 10_000;
    const res = classifyOpenEvent({
      eventTs,
      sentAt,
      userAgent: 'GoogleImageProxy',
    });
    expect(res).toMatchObject({
      classification: 'PROXY_LIKELY',
      countsAsOpen: false,
      source: 'google_image_proxy',
    });
  });

  it('classifies security scanners and bots as MACHINE_LIKELY and does not count', () => {
    const sentAt = Date.parse('2026-09-23T12:00:00.000Z');
    const eventTs = sentAt + 10_000;
    expect(
      classifyOpenEvent({
        eventTs,
        sentAt,
        userAgent: 'Barracuda Sentinel Scanner/1.0',
      }),
    ).toMatchObject({
      classification: 'MACHINE_LIKELY',
      countsAsOpen: false,
      source: 'scanner',
    });

    expect(
      classifyOpenEvent({
        eventTs,
        sentAt,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/100.0',
      }),
    ).toMatchObject({
      classification: 'MACHINE_LIKELY',
      countsAsOpen: false,
      source: 'headless',
    });
  });

  it('classifies empty or unknown user agent as UNKNOWN and does not count', () => {
    const sentAt = Date.parse('2026-09-23T12:00:00.000Z');
    const eventTs = sentAt + 10_000;
    expect(
      classifyOpenEvent({
        eventTs,
        sentAt,
        userAgent: '',
      }),
    ).toMatchObject({
      classification: 'UNKNOWN',
      countsAsOpen: false,
      source: 'unknown',
    });
  });

  it('correlates self view within [-3s, +8s] window', () => {
    const sentAt = Date.parse('2026-09-23T12:00:00.000Z');
    const selfViewTs = sentAt + 10_000;

    // Inside window
    expect(
      classifyOpenEvent({
        eventTs: selfViewTs - 2_000,
        sentAt,
        userAgent: 'Mozilla/5.0 Chrome/120',
        selfViewTs,
      }),
    ).toMatchObject({
      classification: 'SELF_LIKELY',
      countsAsOpen: false,
    });

    expect(
      classifyOpenEvent({
        eventTs: selfViewTs + 7_000,
        sentAt,
        userAgent: 'Mozilla/5.0 Chrome/120',
        selfViewTs,
      }),
    ).toMatchObject({
      classification: 'SELF_LIKELY',
      countsAsOpen: false,
    });

    expect(
      classifyOpenEvent({
        eventTs: selfViewTs + 9_000,
        sentAt,
        userAgent: 'Mozilla/5.0 Chrome/120',
        selfViewTs,
      }),
    ).toMatchObject({
      classification: 'RECIPIENT_LIKELY',
      countsAsOpen: true,
    });
  });

  it('authoritatively derives tracking stats ignoring non-recipient events', () => {
    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: '2026-09-23T12:01:00.000Z',
        classification: 'PROXY_LIKELY',
        userAgent: 'GoogleImageProxy',
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-23T12:02:00.000Z',
        classification: 'MACHINE_LIKELY',
        userAgent: 'Scanner/1.0',
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-23T12:03:00.000Z',
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
        userAgent: 'Mozilla/5.0 Chrome/120',
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-23T12:05:00.000Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      {
        // within 800ms dedupe window
        type: 'OPEN',
        timestamp: '2026-09-23T12:05:00.500Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      {
        // 2nd distinct open
        type: 'OPEN',
        timestamp: '2026-09-23T12:10:00.000Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
    ]);

    expect(stats.openCount).toBe(2);
    expect(stats.firstOpenedAt).toBe('2026-09-23T12:05:00.000Z');
    expect(stats.lastOpenedAt).toBe('2026-09-23T12:10:00.000Z');
  });

  it('normalizes gmail message and thread ids by stripping prefixes and hashes', () => {
    expect(normalizeGmailId('msg-a:r-1234567890')).toBe('r-1234567890');
    expect(normalizeGmailId('msg-f:r-9876543210')).toBe('r-9876543210');
    expect(normalizeGmailId('#msg-a:abc12345')).toBe('abc12345');
    expect(normalizeGmailId('thread-a:189abcdef')).toBe('189abcdef');
    expect(normalizeGmailId('thread-f:189fedcba')).toBe('189fedcba');
    expect(normalizeGmailId('#thread-f:189fedcba')).toBe('189fedcba');
    expect(normalizeGmailId('  msg-a:trimmed  ')).toBe('trimmed');
    expect(normalizeGmailId('already_bare_id')).toBe('already_bare_id');
    expect(normalizeGmailId(null)).toBeNull();
    expect(normalizeGmailId(undefined)).toBeNull();
    expect(normalizeGmailId('')).toBeNull();
  });

  it('reclassifies open event when self-view arrives with original observed timestamp after MV3 background delay', () => {
    const sentAt = Date.parse('2026-09-23T12:00:00.000Z');
    const senderObservedAt = sentAt + 10_000; // T+10s: sender views message in Sent folder
    const pixelOpenTs = senderObservedAt + 500; // T+10.5s: browser requests pixel

    // 1. Initial state when pixel arrives before MV3 background wakes up:
    const initialOpen = classifyOpenEvent({
      eventTs: pixelOpenTs,
      sentAt,
      userAgent: 'Mozilla/5.0 Chrome/120',
      selfViewTs: null,
    });
    expect(initialOpen.classification).toBe('RECIPIENT_LIKELY');
    expect(initialOpen.countsAsOpen).toBe(true);

    const initialEvents = [
      {
        type: 'OPEN',
        timestamp: new Date(pixelOpenTs).toISOString(),
        classification: initialOpen.classification,
        userAgent: 'Mozilla/5.0 Chrome/120',
      },
    ];
    expect(deriveTrackingStats(initialEvents).openCount).toBe(1);

    // 2. MV3 background service worker wakes up 4.5s later (T+15s), sending original observedAt (T+10s).
    // Correlation check against the pixel open:
    expect(isSelfViewCorrelated(pixelOpenTs, senderObservedAt)).toBe(true);

    // 3. Retroactive reclassification executed by backend (recordSelfView in convex/tracking.ts):
    const updatedEvents = [
      {
        type: 'OPEN',
        timestamp: new Date(pixelOpenTs).toISOString(),
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
        userAgent: 'Mozilla/5.0 Chrome/120',
      },
      {
        type: 'SELF_VIEW',
        timestamp: new Date(senderObservedAt).toISOString(),
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
      },
    ];

    const finalStats = deriveTrackingStats(updatedEvents);
    expect(finalStats.openCount).toBe(0);
    expect(finalStats.firstOpenedAt).toBeNull();
    expect(finalStats.lastOpenedAt).toBeNull();
  });
});

