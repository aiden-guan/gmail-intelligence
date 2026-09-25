import { describe, expect, it } from 'vitest';
import * as tracking from './tracking';

type MockDoc = Record<string, any>;

function createMockDb() {
  const tables = new Map<string, MockDoc[]>();
  let idCounter = 1;

  function getTable(table: string): MockDoc[] {
    let t = tables.get(table);
    if (!t) {
      t = [];
      tables.set(table, t);
    }
    return t;
  }

  const db = {
    async insert(table: string, doc: MockDoc) {
      const _id = `${table}_${idCounter++}`;
      const newDoc = { ...doc, _id, _creationTime: Date.now() };
      getTable(table).push(newDoc);
      return _id;
    },
    async patch(id: string, patch: MockDoc) {
      for (const t of tables.values()) {
        const doc = t.find((d) => d._id === id);
        if (doc) {
          Object.assign(doc, patch);
          return;
        }
      }
    },
    async get(id: string) {
      for (const t of tables.values()) {
        const doc = t.find((d) => d._id === id);
        if (doc) return { ...doc };
      }
      return null;
    },
    query(table: string) {
      let docs = [...getTable(table)];

      const builder = {
        withIndex(indexName: string, indexFn?: (q: any) => any) {
          if (indexFn) {
            let eqField: string | null = null;
            let eqVal: any = null;
            const q = {
              eq(field: string, val: any) {
                eqField = field;
                eqVal = val;
                return q;
              },
            };
            indexFn(q);
            if (eqField) {
              docs = docs.filter((d) => d[eqField!] === eqVal);
            }
          }
          return builder;
        },
        filter(filterFn: (q: any) => any) {
          const q = {
            eq(a: any, b: any) {
              return a === b;
            },
            field(name: string) {
              return (doc: any) => doc[name];
            },
          };
          docs = docs.filter((d) => {
            const pred = filterFn({
              eq(left: any, right: any) {
                const val = typeof left === 'function' ? left(d) : left;
                return val === right;
              },
              field(name: string) {
                return (doc: any) => doc[name];
              },
            });
            return pred;
          });
          return builder;
        },
        order(direction: 'asc' | 'desc') {
          if (direction === 'desc') {
            docs.reverse();
          }
          return builder;
        },
        async take(n: number) {
          return docs.slice(0, n).map((d) => ({ ...d }));
        },
        async collect() {
          return docs.map((d) => ({ ...d }));
        },
        async unique() {
          return docs[0] ? { ...docs[0] } : null;
        },
      };
      return builder;
    },
  };

  return { db, ctx: { db } };
}

function callMutation<T = any>(mutation: any, ctx: any, args: any): Promise<T> {
  const fn = mutation._handler || mutation;
  return fn(ctx, args);
}

function callQuery<T = any>(query: any, ctx: any, args: any = {}): Promise<T> {
  const fn = query._handler || query;
  return fn(ctx, args);
}

describe('Convex tracking mutations and self-view suppression', () => {
  it('creates email, handles self-view claim and suppresses subsequent open', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_convex_1';
    const sentAt = new Date().toISOString();

    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Test convex self-view',
      sender: 'sender@example.com',
      recipients: ['recipient@example.com'],
      gmailThreadId: 'thread_1',
      gmailMessageId: 'msg_1',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    const emailBefore = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailBefore.openCount).toBe(0);

    // 1. Sender views own email in Gmail Sent -> emits recordSelfView
    const selfViewTime = new Date().toISOString();
    const selfRes = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_1',
      trackingId,
      timestamp: selfViewTime,
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_1',
      gmailThreadId: 'thread_1',
      gmailMessageId: 'msg_1',
      source: 'MESSAGE_EXPANDED',
    });
    expect(selfRes.ok).toBe(true);
    expect(selfRes.claimId).toBe('clm_evt_sv_1');
    expect(selfRes.openCount).toBe(0);

    // 2. Pixel fetch arrives immediately due to sender opening the email
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_sender',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_1',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    // Email open count should remain 0
    const emailAfterSender = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailAfterSender.openCount).toBe(0);

    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    const openEvent = events.find((e: any) => e.eventId === 'evt_open_sender');
    expect(openEvent).toBeDefined();
    expect(openEvent.classification).toBe('SELF_LIKELY');
    expect(openEvent.suspectedSelfOpen).toBe(true);

    // 3. Duplicate render burst within 1000ms is also suppressed
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_sender_burst',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_1',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const emailAfterBurst = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailAfterBurst.openCount).toBe(0);

    // 4. Genuine recipient open later (claim already consumed)
    const laterOpen = new Date(Date.now() + 5000).toISOString();
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_recipient',
      trackingId,
      type: 'OPEN',
      timestamp: laterOpen,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_2',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const emailAfterRecipient = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailAfterRecipient.openCount).toBe(1);
    expect(emailAfterRecipient.firstOpenedAt).toBe(laterOpen);
  });

  it('retroactively reclassifies open arriving up to 5s before self-view', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_retro_1';
    const baseTime = Date.now();
    const sentAt = new Date(baseTime - 30_000).toISOString();

    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Retro test',
      sender: 'sender@example.com',
      recipients: ['recipient@example.com'],
      gmailThreadId: 'thread_2',
      gmailMessageId: 'msg_2',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    // 1. Pixel arrives before the extension content script reports self-view (e.g. 1.5s prior)
    const openTs = new Date(baseTime - 1500).toISOString();
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_early_pixel',
      trackingId,
      type: 'OPEN',
      timestamp: openTs,
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const emailInitially = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailInitially.openCount).toBe(1);

    // 2. Extension reports self-view at baseTime
    const selfViewRes = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_retro',
      trackingId,
      timestamp: new Date(baseTime).toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_sender',
      gmailThreadId: 'thread_2',
      gmailMessageId: 'msg_2',
      source: 'MESSAGE_EXPANDED',
    });

    expect(selfViewRes.reclassifiedEventIds).toContain('evt_early_pixel');
    expect(selfViewRes.openCount).toBe(0);

    const emailFinal = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailFinal.openCount).toBe(0);
  });

  it('guarantees idempotency on self-view retries with deterministic claim ID', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_idemp_1';
    const sentAt = new Date().toISOString();

    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Idempotency test',
      sender: 'sender@example.com',
      recipients: ['recipient@example.com'],
      gmailThreadId: 'thread_3',
      gmailMessageId: 'msg_3',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    const sv1 = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'selfview_unique_123',
      trackingId,
      timestamp: sentAt,
      userAgent: 'Mozilla/5.0 Chrome',
      gmailThreadId: 'thread_3',
      gmailMessageId: 'msg_3',
      source: 'MESSAGE_EXPANDED',
    });

    expect(sv1.ok).toBe(true);
    expect(sv1.claimId).toBe('clm_selfview_unique_123');

    // Repeated call with the exact same eventId
    const sv2 = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'selfview_unique_123',
      trackingId,
      timestamp: sentAt,
      userAgent: 'Mozilla/5.0 Chrome',
      gmailThreadId: 'thread_3',
      gmailMessageId: 'msg_3',
      source: 'MESSAGE_EXPANDED',
    });

    expect(sv2.ok).toBe(true);
    expect(sv2.claimId).toBe('clm_selfview_unique_123');
  });

  it('isolates claims by exact gmailMessageId in the same thread', async () => {
    const { ctx } = createMockDb();
    const trackingId1 = 'trk_msg1';
    const trackingId2 = 'trk_msg2';
    const now = Date.now();
    const sentAt = new Date(now - 10000).toISOString();

    await callMutation(tracking.createEmail, ctx, {
      trackingId: trackingId1,
      subject: 'Thread Msg 1',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: 'thread_shared',
      gmailMessageId: 'msg_first',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    await callMutation(tracking.createEmail, ctx, {
      trackingId: trackingId2,
      subject: 'Thread Msg 2',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: 'thread_shared',
      gmailMessageId: 'msg_second',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    // Sender views msg_second specifically
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_msg2',
      trackingId: trackingId2,
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_sender',
      gmailThreadId: 'thread_shared',
      gmailMessageId: 'msg_second',
      source: 'MESSAGE_EXPANDED',
    });

    // Recipient opens msg_first (has no claim) -> should count as open!
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_msg1',
      trackingId: trackingId1,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_recipient',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const email1 = await callQuery(tracking.getEmail, ctx, { trackingId: trackingId1 });
    expect(email1.openCount).toBe(1);

    // Pixel for msg_second arrives -> suppressed by claim!
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_msg2',
      trackingId: trackingId2,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const email2 = await callQuery(tracking.getEmail, ctx, { trackingId: trackingId2 });
    expect(email2.openCount).toBe(0);
  });

  it('proxy then sender browser then recipient browser ends at openCount 1 and does not burn the browser claim on the proxy', async () => {
    const { ctx, db } = createMockDb();
    const trackingId = 'trk_proxy_first';
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Proxy first',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: 'thread_p',
      gmailMessageId: 'msg_p',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_proxy',
      trackingId,
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_p',
      source: 'MESSAGE_EXPANDED',
    });

    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_proxy',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 GoogleImageProxy',
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_browser',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_recipient_browser',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(Date.now() + 2000).toISOString(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
      ipHash: 'ip_recipient',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((e: any) => e.eventId === 'evt_proxy').classification).toBe('SELF_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_sender_browser').classification).toBe('SELF_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_recipient_browser').classification).toBe('RECIPIENT_LIKELY');
    const email = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(email.openCount).toBe(1);
    const claims = await db.query('selfViewClaims').collect();
    expect(claims[0].proxyConsumedByEventId).toBe('evt_proxy');
    expect(claims[0].consumedByEventId).toBe('evt_sender_browser');
  });

  it('does not let a different fingerprint consume the sender claim', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_fp';
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Fingerprint',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: 'msg_fp',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_fp',
      trackingId,
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_recipient_first',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
      ipHash: 'ip_recipient',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_after',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(Date.now() + 1500).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const email = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(email.openCount).toBe(1);
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((e: any) => e.eventId === 'evt_recipient_first').classification).toBe('RECIPIENT_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_sender_after').classification).toBe('SELF_LIKELY');
  });

  it('reclassifies only the fingerprint-matched browser open when the pixel arrives before SELF_VIEW', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_retro_fp';
    const base = Date.now();
    const sentAt = new Date(base - 60_000).toISOString();
    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Retro fingerprint',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: 'old_id',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_proxy_before',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(base - 1000).toISOString(),
      userAgent: 'GoogleImageProxy',
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_before',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(base - 800).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_recipient_before',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(base - 700).toISOString(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
      ipHash: 'ip_recipient',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const result = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_retro_fp',
      trackingId,
      timestamp: new Date(base).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      gmailMessageId: 'new_id',
      reconcileGmailIds: true,
      source: 'MESSAGE_EXPANDED',
    });
    expect(result.reclassifiedEventIds).toContain('evt_sender_before');
    expect(result.reclassifiedEventIds).not.toContain('evt_proxy_before');
    expect(result.reclassifiedEventIds).not.toContain('evt_recipient_before');
    const email = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(email.openCount).toBe(1);
    expect(email.gmailMessageId).toBe('new_id');
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((e: any) => e.eventId === 'evt_proxy_before').classification).toBe('PROXY_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_sender_before').classification).toBe('SELF_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_recipient_before').classification).toBe('RECIPIENT_LIKELY');
  });

  it('scanner request does not consume an active sender claim', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_scan';
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Scanner',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: null,
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_scan',
      trackingId,
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_scan',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Barracuda Sentinel Scanner/1.0',
      ipHash: 'ip_scan',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_after_scan',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(Date.now() + 500).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((e: any) => e.eventId === 'evt_scan').classification).toBe('MACHINE_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_sender_after_scan').classification).toBe('SELF_LIKELY');
    const email = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(email.openCount).toBe(0);
  });

  it('counts a Gmail recipient proxy, suppresses one sender proxy, then counts the next recipient proxy', async () => {
    const { ctx, db } = createMockDb();
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const proxyUa = 'Mozilla/5.0 GoogleImageProxy';

    await callMutation(tracking.createEmail, ctx, {
      trackingId: 'trk_proxy_recipient',
      subject: 'Recipient proxy',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: 'msg_proxy_recipient',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_recipient_proxy',
      trackingId: 'trk_proxy_recipient',
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: proxyUa,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const recipientOnly = await callQuery(tracking.getEmail, ctx, { trackingId: 'trk_proxy_recipient' });
    expect(recipientOnly.openCount).toBe(1);
    const recipientEvents = await callQuery(tracking.listEvents, ctx, { trackingId: 'trk_proxy_recipient' });
    expect(recipientEvents.find((event: any) => event.eventId === 'evt_recipient_proxy').classification).toBe('PROXY_LIKELY');

    const base = Date.now();
    await callMutation(tracking.createEmail, ctx, {
      trackingId: 'trk_sender_then_recipient',
      subject: 'Sender then recipient',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: 'msg_sender_then',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_then',
      trackingId: 'trk_sender_then_recipient',
      timestamp: new Date(base).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_sender_then',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_proxy',
      trackingId: 'trk_sender_then_recipient',
      type: 'OPEN',
      timestamp: new Date(base + 200).toISOString(),
      userAgent: proxyUa,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_proxy_burst',
      trackingId: 'trk_sender_then_recipient',
      type: 'OPEN',
      timestamp: new Date(base + 1_200).toISOString(),
      userAgent: proxyUa,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const afterSender = await callQuery(tracking.getEmail, ctx, { trackingId: 'trk_sender_then_recipient' });
    expect(afterSender.openCount).toBe(0);
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_later_recipient_proxy',
      trackingId: 'trk_sender_then_recipient',
      type: 'OPEN',
      timestamp: new Date(base + 4_000).toISOString(),
      userAgent: proxyUa,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const afterRecipient = await callQuery(tracking.getEmail, ctx, { trackingId: 'trk_sender_then_recipient' });
    expect(afterRecipient.openCount).toBe(1);
    const events = await callQuery(tracking.listEvents, ctx, { trackingId: 'trk_sender_then_recipient' });
    expect(events.find((event: any) => event.eventId === 'evt_sender_proxy').classification).toBe('SELF_LIKELY');
    expect(events.find((event: any) => event.eventId === 'evt_sender_proxy_burst').classification).toBe('SELF_LIKELY');
    expect(events.find((event: any) => event.eventId === 'evt_later_recipient_proxy').classification).toBe('PROXY_LIKELY');
    const claims = await db.query('selfViewClaims').collect();
    const claim = claims.find((row) => row.trackingId === 'trk_sender_then_recipient');
    expect(claim).toMatchObject({
      proxyConsumedByEventId: 'evt_sender_proxy',
      consumedByEventId: null,
    });
  });
});
