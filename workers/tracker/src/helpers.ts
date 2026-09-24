/** Pure helpers extracted for unit tests (no Cloudflare runtime required). */

export function safeRedirectUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function normalizeGmailId(value: string | null | undefined): string | null {
  if (!value) return null;
  const next = value.trim().replace(/^#/, '').replace(/^(msg-a:|msg-f:|thread-a:|thread-f:)/i, '');
  return next || null;
}

export type OpenClassification =
  | 'RECIPIENT_LIKELY'
  | 'SELF_LIKELY'
  | 'PROXY_LIKELY'
  | 'MACHINE_LIKELY'
  | 'UNKNOWN';

export type OpenRequestSource =
  | 'browser_like'
  | 'google_image_proxy'
  | 'scanner'
  | 'headless'
  | 'unknown';

export const SELF_VIEW_PRE_WINDOW_MS = 3_000;
export const SELF_VIEW_POST_WINDOW_MS = 8_000;

export function isSelfViewCorrelated(openTs: number, selfViewTs: number): boolean {
  if (!Number.isFinite(openTs) || !Number.isFinite(selfViewTs)) return false;
  return openTs >= selfViewTs - SELF_VIEW_PRE_WINDOW_MS && openTs <= selfViewTs + SELF_VIEW_POST_WINDOW_MS;
}

export function detectOpenRequestSource(userAgent?: string | null): OpenRequestSource {
  if (!userAgent || typeof userAgent !== 'string') return 'unknown';
  const ua = userAgent.trim();
  if (!ua) return 'unknown';

  // 1. Google Image Proxy (ggpht / GoogleImageProxy)
  if (/(googleimageproxy|ggpht)/i.test(ua)) {
    return 'google_image_proxy';
  }

  // 2. Headless browsers & Lighthouse
  if (/(headless|lighthouse|chrome-lighthouse)/i.test(ua)) {
    return 'headless';
  }

  // 3. Security scanners, bots, crawlers, prefetch
  if (
    /(scanner|security|barracuda|proofpoint|mimecast|sophos|symantec|trend\s?micro|avast|bitdefender|virustotal|fireeye|paloalto|zscaler)/i.test(
      ua,
    ) ||
    /\b(bot|crawler|spider|slurp|prefetch|preview)\b/i.test(ua) ||
    /(facebookexternalhit|whatsapp|telegrambot|twitterbot|discordbot|googlebot)/i.test(ua) ||
    /\b(mailproxy|imageproxy)\b/i.test(ua)
  ) {
    return 'scanner';
  }

  // 4. Standard web browsers / mail clients
  if (/mozilla\/\d/i.test(ua) && /(applewebkit|gecko|chrome|safari|firefox|trident|edg)/i.test(ua)) {
    return 'browser_like';
  }

  return 'unknown';
}

export function normalizeUserAgentFamily(userAgent?: string | null): string | null {
  if (!userAgent || typeof userAgent !== 'string') return null;
  const ua = userAgent.trim();
  if (!ua) return null;
  if (/(googleimageproxy|ggpht)/i.test(ua)) return 'google_image_proxy';
  if (/(headless|lighthouse|chrome-lighthouse)/i.test(ua)) return 'headless';
  if (/edg\/|edge\//i.test(ua)) return 'edge';
  if (/firefox|fxios/i.test(ua)) return 'firefox';
  if (/chrome|crios|chromium/i.test(ua)) return 'chrome';
  if (/safari/i.test(ua)) return 'safari';
  if (/mozilla\/\d/i.test(ua)) return 'mozilla';
  return 'other';
}

export function uaFamiliesCompatible(left?: string | null, right?: string | null): boolean {
  return Boolean(left && right && left === right);
}

export type SenderFingerprint = {
  senderIpHash?: string | null;
  senderUaFamily?: string | null;
};

export function senderFingerprintMatches(
  claim: SenderFingerprint | null | undefined,
  request: { ipHash?: string | null; userAgent?: string | null },
): boolean {
  if (!claim?.senderIpHash || !request.ipHash) return false;
  if (claim.senderIpHash !== request.ipHash) return false;
  return uaFamiliesCompatible(claim.senderUaFamily, normalizeUserAgentFamily(request.userAgent));
}

export function openEventMatchesSenderClaim(opts: {
  eventType: string;
  eventTs: number;
  claimStartMs: number;
  claimEndMs: number;
  userAgent?: string | null;
  ipHash?: string | null;
  senderIpHash?: string | null;
  senderUaFamily?: string | null;
}): boolean {
  if (opts.eventType !== 'OPEN' && opts.eventType !== 'CLICK') return false;
  if (!Number.isFinite(opts.eventTs) || opts.eventTs < opts.claimStartMs || opts.eventTs > opts.claimEndMs) return false;
  if (detectOpenRequestSource(opts.userAgent) !== 'browser_like') return false;
  return senderFingerprintMatches(
    { senderIpHash: opts.senderIpHash, senderUaFamily: opts.senderUaFamily },
    { ipHash: opts.ipHash, userAgent: opts.userAgent },
  );
}

function nonBrowserOpenVerdict(source: OpenRequestSource): {
  classification: OpenClassification;
  suspected: boolean;
  confidence: number;
  countsAsOpen: boolean;
  source: OpenRequestSource;
} | null {
  if (source === 'google_image_proxy') {
    return { classification: 'PROXY_LIKELY', suspected: true, confidence: 0.8, countsAsOpen: false, source };
  }
  if (source === 'headless' || source === 'scanner') {
    return { classification: 'MACHINE_LIKELY', suspected: true, confidence: 0.9, countsAsOpen: false, source };
  }
  if (source === 'unknown') {
    return { classification: 'UNKNOWN', suspected: true, confidence: 0.5, countsAsOpen: false, source };
  }
  return null;
}

export function classifyOpen(opts: {
  sentAt: string | null;
  now: number;
  ua: string | null;
  selfViewTs?: number | null;
  hasActiveSenderClaim?: boolean;
}): {
  classification: OpenClassification;
  suspected: boolean;
  confidence: number;
  countsAsOpen: boolean;
  source: OpenRequestSource;
} {
  const sentMs = opts.sentAt ? Date.parse(opts.sentAt) : Number.NaN;
  const source = detectOpenRequestSource(opts.ua);

  if (!opts.sentAt || !Number.isFinite(sentMs) || opts.now < sentMs) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  const machine = nonBrowserOpenVerdict(source);
  if (machine) return machine;

  if (opts.hasActiveSenderClaim) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.now, opts.selfViewTs)) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  return {
    classification: 'RECIPIENT_LIKELY',
    suspected: false,
    confidence: 0,
    countsAsOpen: true,
    source,
  };
}

export function decideTrackedOpen(opts: {
  sentAt: string | null;
  now: number;
  ua: string | null;
  ipHash?: string | null;
  selfViewTs?: number | null;
  activeClaim?: SenderFingerprint | null;
  recentConsumedMatches?: boolean;
}): ReturnType<typeof classifyOpen> & { consumeClaim: boolean } {
  const plain = classifyOpen({
    sentAt: opts.sentAt,
    now: opts.now,
    ua: opts.ua,
    selfViewTs: null,
    hasActiveSenderClaim: false,
  });
  if (plain.source !== 'browser_like' || plain.classification !== 'RECIPIENT_LIKELY') {
    return { ...plain, consumeClaim: false };
  }
  if (senderFingerprintMatches(opts.activeClaim, { ipHash: opts.ipHash, userAgent: opts.ua })) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source: 'browser_like',
      consumeClaim: true,
    };
  }
  if (opts.recentConsumedMatches) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source: 'browser_like',
      consumeClaim: false,
    };
  }
  if (opts.selfViewTs != null) {
    const correlated = classifyOpen({
      sentAt: opts.sentAt,
      now: opts.now,
      ua: opts.ua,
      selfViewTs: opts.selfViewTs,
      hasActiveSenderClaim: false,
    });
    return { ...correlated, consumeClaim: false };
  }
  return { ...plain, consumeClaim: false };
}

export type ClickClassification =
  | 'RECIPIENT_LIKELY'
  | 'SELF_LIKELY'
  | 'MACHINE_LIKELY'
  | 'UNKNOWN';

export type ClickVerdict = {
  classification: ClickClassification;
  suspected: boolean;
  confidence: number;
  countsAsClick: boolean;
  source: OpenRequestSource;
};

export function classifyClick(opts: {
  sentAt: string | null;
  now: number;
  ua: string | null;
  selfViewTs?: number | null;
}): ClickVerdict {
  const sentMs = opts.sentAt ? Date.parse(opts.sentAt) : Number.NaN;
  const source = detectOpenRequestSource(opts.ua);

  // Pre-send clicks
  if (!opts.sentAt || !Number.isFinite(sentMs) || opts.now < sentMs) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Sender self-view correlation
  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.now, opts.selfViewTs)) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Machine / scanner fetches
  if (source === 'headless' || source === 'scanner' || source === 'google_image_proxy') {
    return {
      classification: 'MACHINE_LIKELY',
      suspected: true,
      confidence: 0.9,
      countsAsClick: false,
      source,
    };
  }

  if (source === 'unknown') {
    return {
      classification: 'UNKNOWN',
      suspected: true,
      confidence: 0.5,
      countsAsClick: false,
      source,
    };
  }

  return {
    classification: 'RECIPIENT_LIKELY',
    suspected: false,
    confidence: 0,
    countsAsClick: true,
    source,
  };
}

export type TrackingEventLike = {
  type: string;
  timestamp: string;
  classification?: string | null;
  suspected_self_open?: boolean;
  suspectedSelfOpen?: boolean;
  user_agent?: string | null;
  userAgent?: string | null;
};

export type DerivedTrackingStats = {
  openCount: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  clickCount: number;
  firstClickedAt: string | null;
  lastClickedAt: string | null;
  pixelLoadCount: number;
  possibleOpenCount: number;
};

export function deriveTrackingStats(events: TrackingEventLike[]): DerivedTrackingStats {
  const sorted = [...events].sort((a, b) => (a.timestamp > b.timestamp ? 1 : a.timestamp < b.timestamp ? -1 : 0));
  let openCount = 0;
  let firstOpenedAt: string | null = null;
  let lastOpenedAt: string | null = null;
  let lastValidOpenMs = 0;

  let pixelLoadCount = 0;
  let possibleOpenCount = 0;
  let lastPossibleOpenMs = 0;

  let clickCount = 0;
  let firstClickedAt: string | null = null;
  let lastClickedAt: string | null = null;

  for (const evt of sorted) {
    if (evt.type === 'OPEN') {
      pixelLoadCount += 1;
      const isSelf = Boolean(evt.suspected_self_open || evt.suspectedSelfOpen || evt.classification === 'SELF_LIKELY');
      const isExplicitNonRecipient =
        evt.classification === 'PROXY_LIKELY' ||
        evt.classification === 'MACHINE_LIKELY' ||
        evt.classification === 'UNKNOWN';

      const ua = evt.user_agent || evt.userAgent;
      const detectedSource = ua ? detectOpenRequestSource(ua) : null;
      const isDetectedMachine =
        detectedSource === 'google_image_proxy' ||
        detectedSource === 'headless' ||
        detectedSource === 'scanner' ||
        detectedSource === 'unknown';

      const isRecipient =
        (evt.classification === 'RECIPIENT_LIKELY' || !evt.classification) &&
        !isSelf &&
        !isExplicitNonRecipient &&
        !isDetectedMachine;

      const evtMs = Date.parse(evt.timestamp);

      if (isRecipient) {
        if (!lastValidOpenMs || !Number.isFinite(evtMs) || evtMs < lastValidOpenMs || evtMs - lastValidOpenMs >= 800) {
          openCount += 1;
          lastValidOpenMs = evtMs;
          if (!firstOpenedAt) firstOpenedAt = evt.timestamp;
          lastOpenedAt = evt.timestamp;
        }
      }

      // Possible opens: verified opens or proxy opens (GoogleImageProxy), but self-view takes precedence (SELF_LIKELY excluded)
      const isProxy = evt.classification === 'PROXY_LIKELY' || detectedSource === 'google_image_proxy';
      if (!isSelf && (isRecipient || (isProxy && detectedSource !== 'headless' && detectedSource !== 'scanner'))) {
        if (!lastPossibleOpenMs || !Number.isFinite(evtMs) || evtMs < lastPossibleOpenMs || evtMs - lastPossibleOpenMs >= 800) {
          possibleOpenCount += 1;
          lastPossibleOpenMs = evtMs;
        }
      }
    } else if (evt.type === 'CLICK') {
      const isSelf = Boolean(evt.suspected_self_open || evt.suspectedSelfOpen || evt.classification === 'SELF_LIKELY');
      const ua = evt.user_agent || evt.userAgent;
      const detectedSource = ua ? detectOpenRequestSource(ua) : null;
      const isMachine = evt.classification === 'MACHINE_LIKELY' || detectedSource === 'headless' || detectedSource === 'scanner';
      const isExplicitNonRecipient = isSelf || isMachine || evt.classification === 'UNKNOWN';

      const isRecipientClick =
        evt.classification === 'RECIPIENT_LIKELY' ||
        (!evt.classification && !isExplicitNonRecipient);

      if (isRecipientClick) {
        clickCount += 1;
        if (!firstClickedAt) firstClickedAt = evt.timestamp;
        lastClickedAt = evt.timestamp;
      }
    }
  }

  return {
    openCount,
    firstOpenedAt,
    lastOpenedAt,
    clickCount,
    firstClickedAt,
    lastClickedAt,
    pixelLoadCount,
    possibleOpenCount,
  };
}

export function suspectSelfOpen(opts: {
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
