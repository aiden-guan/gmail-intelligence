import { describe, expect, it } from 'vitest';
import { decideTrackedOpen as convexDecide, deriveTrackingStats as convexStats, selectSenderProxyClaim as convexSelect } from '../../../convex/openRequest';
import { decideTrackedOpen as workerDecide, deriveTrackingStats as workerStats, selectSenderProxyClaim as workerSelect } from '../../../workers/tracker/src/helpers';
import {
  decideTrackedOpen,
  deriveTrackingStats,
  selectSenderProxyClaim,
  type ProxyClaimCandidate,
  type ProxySuppressionMode,
} from './lifecycle';

const sent = Date.parse('2026-09-24T12:00:00.000Z');
const browserUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const proxyUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy';
const scannerUa = 'Proofpoint-URL-Scanner/2.0';
const senderClaim = { senderIpHash: 'ip_sender', senderUaFamily: 'chrome' };

type Decision = {
  classification: string;
  countsAsOpen: boolean;
  consumeClaim: boolean;
  consumeProxySuppression: boolean;
};

function sameDecision(input: {
  eventTs: number;
  sentAt: number | null;
  userAgent: string | null;
  ipHash?: string | null;
  selfViewTs?: number | null;
  activeClaim?: { senderIpHash?: string | null; senderUaFamily?: string | null } | null;
  recentConsumedMatches?: boolean;
  proxySuppression?: ProxySuppressionMode;
}): Decision {
  const tracking = decideTrackedOpen(input);
  const convex = convexDecide(input);
  const worker = workerDecide({
    sentAt: input.sentAt == null ? null : new Date(input.sentAt).toISOString(),
    now: input.eventTs,
    ua: input.userAgent,
    ipHash: input.ipHash,
    selfViewTs: input.selfViewTs,
    activeClaim: input.activeClaim,
    recentConsumedMatches: input.recentConsumedMatches,
    proxySuppression: input.proxySuppression,
  });
  const pick = (verdict: Decision): Decision => ({
    classification: verdict.classification,
    countsAsOpen: verdict.countsAsOpen,
    consumeClaim: verdict.consumeClaim,
    consumeProxySuppression: verdict.consumeProxySuppression,
  });
  expect(pick(convex)).toEqual(pick(tracking));
  expect(pick(worker)).toEqual(pick(tracking));
  return pick(tracking);
}

describe('open decision order', () => {
  it('A. counts a GoogleImageProxy request when no sender proxy suppression exists', () => {
    expect(
      sameDecision({
        eventTs: sent + 30_000,
        sentAt: sent,
        userAgent: proxyUa,
        ipHash: 'ip_google',
        activeClaim: senderClaim,
        proxySuppression: 'none',
      }),
    ).toEqual({
      classification: 'PROXY_LIKELY',
      countsAsOpen: true,
      consumeClaim: false,
      consumeProxySuppression: false,
    });
  });

  it('B. suppresses one sender GoogleImageProxy render and consumes only the proxy slot', () => {
    expect(
      sameDecision({
        eventTs: sent + 30_000,
        sentAt: sent,
        userAgent: proxyUa,
        proxySuppression: 'consume',
        activeClaim: senderClaim,
      }),
    ).toEqual({
      classification: 'SELF_LIKELY',
      countsAsOpen: false,
      consumeClaim: false,
      consumeProxySuppression: true,
    });
  });

  it('C. a consumed sender proxy does not suppress a later recipient proxy', () => {
    expect(
      sameDecision({
        eventTs: sent + 31_000,
        sentAt: sent,
        userAgent: proxyUa,
        proxySuppression: 'burst',
      }),
    ).toMatchObject({ classification: 'SELF_LIKELY', countsAsOpen: false, consumeClaim: false, consumeProxySuppression: false });
    expect(
      sameDecision({
        eventTs: sent + 40_000,
        sentAt: sent,
        userAgent: proxyUa,
        proxySuppression: 'none',
      }),
    ).toMatchObject({ classification: 'PROXY_LIKELY', countsAsOpen: true, consumeProxySuppression: false });
  });

  it('D. a proxy render does not consume the browser sender claim', () => {
    const proxy = sameDecision({
      eventTs: sent + 30_000,
      sentAt: sent,
      userAgent: proxyUa,
      ipHash: 'ip_google',
      activeClaim: senderClaim,
      proxySuppression: 'consume',
    });
    expect(proxy.consumeProxySuppression).toBe(true);
    expect(proxy.consumeClaim).toBe(false);
    expect(
      sameDecision({
        eventTs: sent + 31_000,
        sentAt: sent,
        userAgent: browserUa,
        ipHash: 'ip_sender',
        activeClaim: senderClaim,
        proxySuppression: 'none',
      }),
    ).toEqual({
      classification: 'SELF_LIKELY',
      countsAsOpen: false,
      consumeClaim: true,
      consumeProxySuppression: false,
    });
  });

  it('E. scanners and headless clients stay uncounted and do not consume claims', () => {
    expect(
      sameDecision({
        eventTs: sent + 30_000,
        sentAt: sent,
        userAgent: scannerUa,
        activeClaim: senderClaim,
        proxySuppression: 'consume',
      }),
    ).toMatchObject({ classification: 'MACHINE_LIKELY', countsAsOpen: false, consumeClaim: false, consumeProxySuppression: false });
    expect(
      sameDecision({
        eventTs: sent + 30_000,
        sentAt: sent,
        userAgent: 'Mozilla/5.0 HeadlessChrome/120.0.0.0',
      }),
    ).toMatchObject({ classification: 'MACHINE_LIKELY', countsAsOpen: false });
  });

  it('F. a browser-like recipient with no matching sender claim counts', () => {
    expect(
      sameDecision({
        eventTs: sent + 60_000,
        sentAt: sent,
        userAgent: browserUa,
        ipHash: 'ip_recipient',
        activeClaim: senderClaim,
      }),
    ).toEqual({
      classification: 'RECIPIENT_LIKELY',
      countsAsOpen: true,
      consumeClaim: false,
      consumeProxySuppression: false,
    });
  });

  it('G. aggregation counts proxy and recipient opens and skips self and machine', () => {
    const events = [
      {
        type: 'OPEN',
        timestamp: '2026-09-24T12:01:00.000Z',
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
        userAgent: proxyUa,
        user_agent: proxyUa,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T12:02:00.000Z',
        classification: 'PROXY_LIKELY',
        userAgent: proxyUa,
        user_agent: proxyUa,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T12:03:00.000Z',
        classification: 'MACHINE_LIKELY',
        userAgent: scannerUa,
        user_agent: scannerUa,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T12:04:00.000Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: browserUa,
        user_agent: browserUa,
      },
    ];
    expect(deriveTrackingStats(events).openCount).toBe(2);
    expect(convexStats(events).openCount).toBe(2);
    expect(workerStats(events).openCount).toBe(2);
  });

  it('does not use the claim TTL to suppress every later Google proxy', () => {
    const observed = '2026-09-24T12:00:30.000Z';
    const claim: ProxyClaimCandidate = {
      id: 'clm_1',
      gmailMessageId: 'msg_1',
      lastObservedAt: observed,
      expiresAt: new Date(Date.parse(observed) + 25_000).toISOString(),
      proxyConsumedByEventId: 'evt_proxy',
      proxyConsumedAt: observed,
    };
    const stillInsideTtl = Date.parse(observed) + 10_000;
    expect(selectSenderProxyClaim([claim], stillInsideTtl, 'msg_1')).toBeNull();
    expect(convexSelect([claim], stillInsideTtl, 'msg_1')).toBeNull();
    expect(workerSelect([claim], stillInsideTtl, 'msg_1')).toBeNull();

    const fresh = { ...claim, proxyConsumedByEventId: null, proxyConsumedAt: null };
    expect(selectSenderProxyClaim([fresh], stillInsideTtl, 'msg_1')?.mode).toBe('consume');
    expect(convexSelect([fresh], stillInsideTtl, 'msg_1')?.mode).toBe('consume');
    expect(workerSelect([fresh], stillInsideTtl, 'msg_1')?.mode).toBe('consume');

    const burstAt = Date.parse(observed) + 1_500;
    expect(selectSenderProxyClaim([claim], burstAt, 'msg_1')?.mode).toBe('burst');
    expect(convexSelect([claim], burstAt, 'msg_1')?.mode).toBe('burst');
    expect(workerSelect([claim], burstAt, 'msg_1')?.mode).toBe('burst');
  });

  it('classifies pre-send proxy fetches as self and does not consume suppression', () => {
    expect(
      sameDecision({
        eventTs: sent - 1,
        sentAt: sent,
        userAgent: proxyUa,
        proxySuppression: 'consume',
      }),
    ).toMatchObject({ classification: 'SELF_LIKELY', countsAsOpen: false, consumeClaim: false, consumeProxySuppression: false });
  });
});
