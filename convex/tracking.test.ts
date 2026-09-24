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
      userAgent: 'Chrome',
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
});
