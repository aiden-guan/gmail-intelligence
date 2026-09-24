import { describe, expect, it } from 'vitest';
import { classifyOpenEvent, publicTrackerOrigin, trackingIdFromUrl } from './openRequest';

describe('open pixel urls', () => {
  it('reads a tracking id from a gif path and an extensionless path', () => {
    expect(trackingIdFromUrl('https://eagle.convex.site/open/trk_abc123.gif')).toBe('trk_abc123');
    expect(trackingIdFromUrl('https://eagle.convex.site/open/trk_abc123')).toBe('trk_abc123');
    expect(trackingIdFromUrl('https://eagle.convex.site/open/trk_abc123.gif?cache=1')).toBe('trk_abc123');
  });

  it('does not count a pixel fetch that happens before the message is sent', () => {
    const now = Date.parse('2026-09-23T12:00:00.000Z');
    expect(classifyOpenEvent({ eventTs: now, sentAt: null, userAgent: 'Mozilla' })).toMatchObject({
      classification: 'SELF_LIKELY',
      countsAsOpen: false,
    });
    expect(
      classifyOpenEvent({ eventTs: now, sentAt: now + 5_000, userAgent: 'Mozilla' }).countsAsOpen,
    ).toBe(false);
    expect(
      classifyOpenEvent({ eventTs: now + 60_000, sentAt: now, userAgent: 'Mozilla' }),
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
});
