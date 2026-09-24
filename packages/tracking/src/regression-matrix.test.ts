import { describe, expect, it } from 'vitest';
import {
  applyRecentOpens,
  deriveTrackingStats,
  describeTrackingStatus,
  detectOpenRequestSource,
  isSelfViewCorrelated,
  matchTrackedEmail,
  normalizeGmailId,
  transformOutgoingHtml,
  type TrackedEmailSummary,
  type TrackingEvent,
} from './index';

describe('Regression Matrix (Cases A through N)', () => {
  // Case A: Same thread, second email sent -> second email unread -> row must show UNREAD / gray.
  it('Case A: Same thread, second email sent -> second email unread -> row must show UNREAD / pending', () => {
    const olderOpened: TrackedEmailSummary = {
      trackingId: 'trk_send_1',
      subject: 'Discussion',
      sender: 'me@example.com',
      recipients: ['alice@example.com'],
      gmailThreadId: 'thread_100',
      gmailMessageId: 'msg_1',
      sentAt: '2026-09-24T10:00:00.000Z',
      firstOpenedAt: '2026-09-24T10:05:00.000Z',
      lastOpenedAt: '2026-09-24T10:05:00.000Z',
      openCount: 1,
      clickCount: 0,
      notifyIfNoReply: false,
    };
    const newerUnread: TrackedEmailSummary = {
      trackingId: 'trk_send_2',
      subject: 'Discussion',
      sender: 'me@example.com',
      recipients: ['alice@example.com'],
      gmailThreadId: 'thread_100',
      gmailMessageId: 'msg_2',
      sentAt: '2026-09-24T12:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    const matched = matchTrackedEmail(
      { threadIds: ['thread_100'], subject: 'Discussion', emails: ['alice@example.com'] },
      [olderOpened, newerUnread],
    );

    expect(matched?.trackingId).toBe('trk_send_2');
    expect(matched?.openCount).toBe(0);
    const status = describeTrackingStatus(matched!, { trackerBaseUrl: 'https://track.example' });
    expect(status.opened).toBe(false);
    expect(status.markLabel).toBe('Sent');
    expect(status.countLabel).toBe('Not opened yet');
  });

  // Case B: Same thread, second email sent -> second email opened -> row must show OPENED.
  it('Case B: Same thread, second email sent -> second email opened -> row must show OPENED', () => {
    const olderUnread: TrackedEmailSummary = {
      trackingId: 'trk_send_1',
      subject: 'Discussion',
      sender: 'me@example.com',
      recipients: ['alice@example.com'],
      gmailThreadId: 'thread_100',
      gmailMessageId: 'msg_1',
      sentAt: '2026-09-24T10:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };
    const newerOpened: TrackedEmailSummary = {
      trackingId: 'trk_send_2',
      subject: 'Discussion',
      sender: 'me@example.com',
      recipients: ['alice@example.com'],
      gmailThreadId: 'thread_100',
      gmailMessageId: 'msg_2',
      sentAt: '2026-09-24T12:00:00.000Z',
      firstOpenedAt: '2026-09-24T12:10:00.000Z',
      lastOpenedAt: '2026-09-24T12:10:00.000Z',
      openCount: 1,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    const matched = matchTrackedEmail(
      { threadIds: ['thread_100'], subject: 'Discussion', emails: ['alice@example.com'] },
      [olderUnread, newerOpened],
    );

    expect(matched?.trackingId).toBe('trk_send_2');
    expect(matched?.openCount).toBe(1);
    const status = describeTrackingStatus(matched!, { trackerBaseUrl: 'https://track.example' });
    expect(status.opened).toBe(true);
    expect(status.markLabel).toBe('Opened');
    expect(status.countLabel).toBe('Opened once');
  });

  // Case C: GoogleImageProxy fetch alone -> raw event logged -> openCount remains 0.
  it('Case C: GoogleImageProxy fetch alone -> raw event logged -> openCount remains 0', () => {
    const proxyUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 GoogleImageProxy';
    expect(detectOpenRequestSource(proxyUA)).toBe('google_image_proxy');

    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:01:00.000Z',
        userAgent: proxyUA,
        classification: 'PROXY_LIKELY',
      },
    ]);
    expect(stats.openCount).toBe(0);
    expect(stats.firstOpenedAt).toBeNull();
  });

  // Case D: Bot / scanner / headless fetch -> raw event logged -> openCount remains 0.
  it('Case D: Bot / scanner / headless fetch -> raw event logged -> openCount remains 0', () => {
    const scannerUA = 'Barracuda Sentinel Scanner/2.1 (Security Crawler)';
    const headlessUA = 'Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36';

    expect(detectOpenRequestSource(scannerUA)).toBe('scanner');
    expect(detectOpenRequestSource(headlessUA)).toBe('headless');

    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:01:00.000Z',
        userAgent: scannerUA,
        classification: 'MACHINE_LIKELY',
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:02:00.000Z',
        userAgent: headlessUA,
        classification: 'MACHINE_LIKELY',
      },
    ]);
    expect(stats.openCount).toBe(0);
  });

  // Case E: Missing UA fetch -> raw event logged -> openCount remains 0.
  it('Case E: Missing UA fetch -> raw event logged -> openCount remains 0', () => {
    expect(detectOpenRequestSource('')).toBe('unknown');
    expect(detectOpenRequestSource(null)).toBe('unknown');
    expect(detectOpenRequestSource(undefined)).toBe('unknown');

    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:01:00.000Z',
        userAgent: null,
        classification: 'UNKNOWN',
      },
    ]);
    expect(stats.openCount).toBe(0);
  });

  // Case F: Self-view in Sent folder -> open arrives 1.5s later -> self-view suppresses open.
  it('Case F: Self-view in Sent folder -> open arrives 1.5s later -> self-view suppresses open', () => {
    const selfViewTs = Date.parse('2026-09-24T10:00:00.000Z');
    const openTs = selfViewTs + 1500; // 1.5s later

    expect(isSelfViewCorrelated(openTs, selfViewTs)).toBe(true);

    const stats = deriveTrackingStats([
      {
        type: 'SELF_VIEW',
        timestamp: new Date(selfViewTs).toISOString(),
      },
      {
        type: 'OPEN',
        timestamp: new Date(openTs).toISOString(),
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
      },
    ]);
    expect(stats.openCount).toBe(0);
  });

  // Case G: Recipient opens email -> openCount becomes 1 -> sender opens email 20s later -> openCount remains 1.
  it('Case G: Recipient opens email -> openCount becomes 1 -> sender opens email 20s later -> openCount remains 1', () => {
    const recipientOpenTs = Date.parse('2026-09-24T10:00:00.000Z');
    const senderSelfViewTs = recipientOpenTs + 20_000;
    const senderPixelOpenTs = senderSelfViewTs + 500;

    // Recipient open is NOT correlated with sender self view (+20s later)
    expect(isSelfViewCorrelated(recipientOpenTs, senderSelfViewTs)).toBe(false);
    // Sender pixel open IS correlated with sender self view
    expect(isSelfViewCorrelated(senderPixelOpenTs, senderSelfViewTs)).toBe(true);

    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: new Date(recipientOpenTs).toISOString(),
        classification: 'RECIPIENT_LIKELY',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
      {
        type: 'SELF_VIEW',
        timestamp: new Date(senderSelfViewTs).toISOString(),
      },
      {
        type: 'OPEN',
        timestamp: new Date(senderPixelOpenTs).toISOString(),
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    ]);

    expect(stats.openCount).toBe(1);
    expect(stats.firstOpenedAt).toBe(new Date(recipientOpenTs).toISOString());
    expect(stats.lastOpenedAt).toBe(new Date(recipientOpenTs).toISOString());
  });

  // Case H: Deduplicated pixel reload within 800ms -> openCount increments by 1, not 2.
  it('Case H: Deduplicated pixel reload within 800ms -> openCount increments by 1, not 2', () => {
    const browserUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:00:00.000Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: browserUA,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:00:00.500Z', // 500ms later (< 800ms)
        classification: 'RECIPIENT_LIKELY',
        userAgent: browserUA,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:05:00.000Z', // 5 mins later (> 800ms)
        classification: 'RECIPIENT_LIKELY',
        userAgent: browserUA,
      },
    ]);

    expect(stats.openCount).toBe(2);
    expect(stats.firstOpenedAt).toBe('2026-09-24T10:00:00.000Z');
    expect(stats.lastOpenedAt).toBe('2026-09-24T10:05:00.000Z');
  });

  // Case I: Worker store derives aggregates correctly on self-view reclassification.
  it('Case I: Worker store derives aggregates correctly on self-view reclassification', () => {
    const rawEvents: Array<{
      type: string;
      timestamp: string;
      classification?: string;
      suspectedSelfOpen?: boolean;
      userAgent?: string | null;
    }> = [
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:00:01.000Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    ];

    let stats = deriveTrackingStats(rawEvents);
    expect(stats.openCount).toBe(1);

    // Now a self-view is registered at 10:00:00.000Z, reclassifying the open at 10:00:01.000Z to SELF_LIKELY
    rawEvents[0].classification = 'SELF_LIKELY';
    rawEvents[0].suspectedSelfOpen = true;

    stats = deriveTrackingStats(rawEvents);
    expect(stats.openCount).toBe(0);
    expect(stats.firstOpenedAt).toBeNull();
  });

  // Case J: Stale row reuse in UI does not report wrong email on click.
  it('Case J: Client applyRecentOpens ignores machine, proxy, and self opens', () => {
    const email: TrackedEmailSummary = {
      trackingId: 'trk_test',
      subject: 'Test',
      sender: 'me@example.com',
      recipients: ['bob@example.com'],
      gmailThreadId: 'thread_1',
      gmailMessageId: 'msg_1',
      sentAt: '2026-09-24T10:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    const machineEvents: TrackingEvent[] = [
      {
        id: 'ev_1',
        tracking_id: 'trk_test',
        type: 'OPEN',
        timestamp: '2026-09-24T10:01:00.000Z',
        classification: 'PROXY_LIKELY',
        user_agent: 'GoogleImageProxy',
      },
      {
        id: 'ev_2',
        tracking_id: 'trk_test',
        type: 'OPEN',
        timestamp: '2026-09-24T10:02:00.000Z',
        classification: 'MACHINE_LIKELY',
        user_agent: 'Scanner/1.0',
      },
      {
        id: 'ev_3',
        tracking_id: 'trk_test',
        type: 'OPEN',
        timestamp: '2026-09-24T10:03:00.000Z',
        classification: 'SELF_LIKELY',
        suspected_self_open: true,
        user_agent: 'Mozilla/5.0 Chrome/120',
      },
    ];

    const updated = applyRecentOpens([email], machineEvents);
    expect(updated[0].openCount).toBe(0);
    expect(updated[0].firstOpenedAt).toBeNull();
  });

  // Case K: Exact messageId match prioritizes correct email even if threadId has multiple sends.
  it('Case K: Exact messageId match prioritizes correct email even if threadId has multiple sends', () => {
    const send1: TrackedEmailSummary = {
      trackingId: 'trk_1',
      subject: 'Thread Test',
      sender: 'me@example.com',
      recipients: ['carol@example.com'],
      gmailThreadId: 'thread_xyz',
      gmailMessageId: 'msg_send_1',
      sentAt: '2026-09-24T08:00:00.000Z',
      firstOpenedAt: '2026-09-24T08:10:00.000Z',
      lastOpenedAt: '2026-09-24T08:10:00.000Z',
      openCount: 1,
      clickCount: 0,
      notifyIfNoReply: false,
    };
    const send2: TrackedEmailSummary = {
      trackingId: 'trk_2',
      subject: 'Thread Test',
      sender: 'me@example.com',
      recipients: ['carol@example.com'],
      gmailThreadId: 'thread_xyz',
      gmailMessageId: 'msg_send_2',
      sentAt: '2026-09-24T12:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    // Query targeting message msg_send_1 specifically inside thread_xyz
    const matchMsg1 = matchTrackedEmail(
      {
        threadIds: ['thread_xyz'],
        messageId: 'msg_send_1',
        messageIds: ['msg_send_1'],
        subject: 'Thread Test',
        emails: ['carol@example.com'],
      },
      [send1, send2],
    );
    expect(matchMsg1?.trackingId).toBe('trk_1');

    // Query targeting message msg_send_2 specifically inside thread_xyz
    const matchMsg2 = matchTrackedEmail(
      {
        threadIds: ['thread_xyz'],
        messageId: 'msg_send_2',
        messageIds: ['msg_send_2'],
        subject: 'Thread Test',
        emails: ['carol@example.com'],
      },
      [send1, send2],
    );
    expect(matchMsg2?.trackingId).toBe('trk_2');
  });

  // Case L: Outbound compose tracking injection remains untouched and produces working MIME.
  it('Case L: Outbound compose tracking injection produces working HTML with pixel and link rewrites', () => {
    const inputHtml = '<div>Hello Carol, please check <a href="https://example.com/docs">our docs</a>.</div>';
    const pixelUrl = 'https://track.example/open/trk_case_l.gif';
    const rewritten = transformOutgoingHtml(inputHtml, {
      pixelUrl,
      trackOpens: true,
      trackLinks: true,
      linkMap: new Map([
        ['https://example.com/docs', 'https://track.example/c/clk_123'],
      ]),
    });

    expect(rewritten.pixelPresent).toBe(true);
    expect(rewritten.linksRewritten).toBe(1);
    expect(rewritten.html).toContain('https://track.example/c/clk_123');
    expect(rewritten.html).toContain('<img src="https://track.example/open/trk_case_l.gif"');
    expect(rewritten.html).toContain('role="presentation"');
  });

  // Case M: MV3 background wake-up delay - sender interaction observed timestamp reclassifies open and resets open count to 0.
  it('Case M: MV3 background wake-up delay - sender interaction observed timestamp reclassifies open and resets open count to 0', () => {
    const sentAt = Date.parse('2026-09-24T12:00:00.000Z');
    const senderObservedAt = sentAt + 10_000; // T+10s: sender views email in Sent folder
    const openArrivalTs = senderObservedAt + 500; // T+10.5s: pixel fetch arrives at server

    // Before self-view arrives, pixel fetch is considered a recipient open:
    const initialEvents: TrackingEvent[] = [
      {
        id: 'ev_open_1',
        tracking_id: 'trk_mv3_delay',
        type: 'OPEN',
        timestamp: new Date(openArrivalTs).toISOString(),
        classification: 'RECIPIENT_LIKELY',
        user_agent: 'Mozilla/5.0 Chrome/120',
      },
    ];

    const email: TrackedEmailSummary = {
      trackingId: 'trk_mv3_delay',
      subject: 'MV3 Delay Matrix Test',
      sender: 'me@example.com',
      recipients: ['recipient@example.com'],
      gmailThreadId: 'thread_mv3',
      gmailMessageId: 'msg_mv3',
      sentAt: new Date(sentAt).toISOString(),
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    let updated = applyRecentOpens([email], initialEvents);
    expect(updated[0].openCount).toBe(1);

    // MV3 background service worker wakes up 5 seconds later (T+15s), but sends the content script interaction timestamp (T+10s):
    expect(isSelfViewCorrelated(openArrivalTs, senderObservedAt)).toBe(true);

    const reclassifiedEvents: TrackingEvent[] = [
      {
        id: 'ev_open_1',
        tracking_id: 'trk_mv3_delay',
        type: 'OPEN',
        timestamp: new Date(openArrivalTs).toISOString(),
        classification: 'SELF_LIKELY',
        suspected_self_open: true,
        user_agent: 'Mozilla/5.0 Chrome/120',
      },
      {
        id: 'ev_self_1',
        tracking_id: 'trk_mv3_delay',
        type: 'SELF_VIEW',
        timestamp: new Date(senderObservedAt).toISOString(),
        classification: 'SELF_LIKELY',
        suspected_self_open: true,
      },
    ];

    updated = applyRecentOpens([email], reclassifiedEvents);
    expect(updated[0].openCount).toBe(0);
    expect(updated[0].firstOpenedAt).toBeNull();

    const stats = deriveTrackingStats(reclassifiedEvents);
    expect(stats.openCount).toBe(0);
    expect(stats.firstOpenedAt).toBeNull();
  });

  // Case N: Gmail ID normalization with msg-a: / thread-f: prefixes matches stored bare IDs accurately in thread view.
  it('Case N: Gmail ID normalization with msg-a: / thread-f: prefixes matches stored bare IDs accurately', () => {
    expect(normalizeGmailId('msg-a:r-1234567890')).toBe('r-1234567890');
    expect(normalizeGmailId('#thread-f:thread-abc')).toBe('thread-abc');

    const storedEmail: TrackedEmailSummary = {
      trackingId: 'trk_norm_test',
      subject: 'Normalized IDs',
      sender: 'me@example.com',
      recipients: ['bob@example.com'],
      gmailThreadId: 'thread_xyz',
      gmailMessageId: 'msg_bare_123',
      sentAt: '2026-09-24T10:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    // Client query arrives from InboxSDK MessageView with 'msg-a:msg_bare_123' and thread 'thread-f:thread_xyz'
    const matched = matchTrackedEmail(
      {
        threadIds: ['thread-f:thread_xyz'],
        messageId: 'msg-a:msg_bare_123',
        messageIds: ['msg-a:msg_bare_123'],
        subject: 'Normalized IDs',
        emails: ['bob@example.com'],
      },
      [storedEmail],
    );

    expect(matched?.trackingId).toBe('trk_norm_test');
  });
});
