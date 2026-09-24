/** Pure helpers for the public pixel route. Kept out of the HTTP action so tests can run them. */

export function trackingIdFromUrl(url: string): string | null {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    decoded = url;
  }
  const match = decoded.match(/\/open\/([A-Za-z0-9_-]{6,80})/i);
  if (!match?.[1]) return null;
  return match[1].replace(/\.(gif|png|jpe?g|webp)$/i, '');
}

export function normalizeGmailId(value: string | null | undefined): string | null {
  if (!value) return null;
  const next = value.trim().replace(/^#/, '').replace(/^(msg-a:|msg-f:|thread-a:|thread-f:)/i, '');
  return next || null;
}

export type OpenClassification =
  | "RECIPIENT_LIKELY"
  | "SELF_LIKELY"
  | "PROXY_LIKELY"
  | "MACHINE_LIKELY"
  | "UNKNOWN";

export type OpenRequestSource =
  | "browser_like"
  | "google_image_proxy"
  | "scanner"
  | "headless"
  | "unknown";

export const SELF_VIEW_PRE_WINDOW_MS = 3_000;
export const SELF_VIEW_POST_WINDOW_MS = 8_000;

export function isSelfViewCorrelated(openTs: number, selfViewTs: number): boolean {
  if (!Number.isFinite(openTs) || !Number.isFinite(selfViewTs)) return false;
  return openTs >= selfViewTs - SELF_VIEW_PRE_WINDOW_MS && openTs <= selfViewTs + SELF_VIEW_POST_WINDOW_MS;
}

export function detectOpenRequestSource(userAgent?: string | null): OpenRequestSource {
  if (!userAgent || typeof userAgent !== "string") return "unknown";
  const ua = userAgent.trim();
  if (!ua) return "unknown";

  // 1. Google Image Proxy (ggpht / GoogleImageProxy)
  if (/(googleimageproxy|ggpht)/i.test(ua)) {
    return "google_image_proxy";
  }

  // 2. Headless browsers & Lighthouse
  if (/(headless|lighthouse|chrome-lighthouse)/i.test(ua)) {
    return "headless";
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
    return "scanner";
  }

  // 4. Standard web browsers / mail clients
  if (/mozilla\/\d/i.test(ua) && /(applewebkit|gecko|chrome|safari|firefox|trident|edg)/i.test(ua)) {
    return "browser_like";
  }

  return "unknown";
}

export function classifyOpenEvent(opts: {
  eventTs: number;
  sentAt: number | null;
  userAgent?: string | null;
  selfViewTs?: number | null;
}): {
  classification: OpenClassification;
  suspected: boolean;
  confidence: number;
  countsAsOpen: boolean;
  source: OpenRequestSource;
} {
  const sentAt = opts.sentAt;
  const source = detectOpenRequestSource(opts.userAgent);

  // Pre-send fetches
  if (sentAt == null || !Number.isFinite(sentAt) || opts.eventTs < sentAt) {
    return {
      classification: "SELF_LIKELY",
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  // Sender self-view correlation
  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.eventTs, opts.selfViewTs)) {
    return {
      classification: "SELF_LIKELY",
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  // Machine / Proxy fetches
  if (source === "google_image_proxy") {
    return {
      classification: "PROXY_LIKELY",
      suspected: true,
      confidence: 0.8,
      countsAsOpen: false,
      source,
    };
  }

  if (source === "headless" || source === "scanner") {
    return {
      classification: "MACHINE_LIKELY",
      suspected: true,
      confidence: 0.9,
      countsAsOpen: false,
      source,
    };
  }

  if (source === "unknown") {
    return {
      classification: "UNKNOWN",
      suspected: true,
      confidence: 0.5,
      countsAsOpen: false,
      source,
    };
  }

  // Genuine recipient open
  return {
    classification: "RECIPIENT_LIKELY",
    suspected: false,
    confidence: 0,
    countsAsOpen: true,
    source,
  };
}

export type ClickClassification =
  | "RECIPIENT_LIKELY"
  | "SELF_LIKELY"
  | "MACHINE_LIKELY"
  | "UNKNOWN";

export type ClickVerdict = {
  classification: ClickClassification;
  suspected: boolean;
  confidence: number;
  countsAsClick: boolean;
  source: OpenRequestSource;
};

export function classifyClickEvent(opts: {
  eventTs: number;
  sentAt: number | null;
  userAgent?: string | null;
  selfViewTs?: number | null;
}): ClickVerdict {
  const sentAt = opts.sentAt;
  const source = detectOpenRequestSource(opts.userAgent);

  // Pre-send clicks
  if (sentAt == null || !Number.isFinite(sentAt) || opts.eventTs < sentAt) {
    return {
      classification: "SELF_LIKELY",
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Correlated sender self-view takes precedence
  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.eventTs, opts.selfViewTs)) {
    return {
      classification: "SELF_LIKELY",
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Machine / scanner fetches
  if (source === "headless" || source === "scanner" || source === "google_image_proxy") {
    return {
      classification: "MACHINE_LIKELY",
      suspected: true,
      confidence: 0.9,
      countsAsClick: false,
      source,
    };
  }

  if (source === "unknown") {
    return {
      classification: "UNKNOWN",
      suspected: true,
      confidence: 0.5,
      countsAsClick: false,
      source,
    };
  }

  return {
    classification: "RECIPIENT_LIKELY",
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
  suspectedSelfOpen?: boolean;
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
    if (evt.type === "OPEN") {
      pixelLoadCount += 1;
      const isSelf = Boolean(evt.suspectedSelfOpen || evt.classification === "SELF_LIKELY");
      const isExplicitNonRecipient =
        evt.classification === "PROXY_LIKELY" ||
        evt.classification === "MACHINE_LIKELY" ||
        evt.classification === "UNKNOWN";

      const ua = evt.userAgent;
      const detectedSource = ua ? detectOpenRequestSource(ua) : null;
      const isDetectedMachine =
        detectedSource === "google_image_proxy" ||
        detectedSource === "headless" ||
        detectedSource === "scanner" ||
        detectedSource === "unknown";

      const isRecipient =
        (evt.classification === "RECIPIENT_LIKELY" || !evt.classification) &&
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
      const isProxy = evt.classification === "PROXY_LIKELY" || detectedSource === "google_image_proxy";
      if (!isSelf && (isRecipient || (isProxy && detectedSource !== "headless" && detectedSource !== "scanner"))) {
        if (!lastPossibleOpenMs || !Number.isFinite(evtMs) || evtMs < lastPossibleOpenMs || evtMs - lastPossibleOpenMs >= 800) {
          possibleOpenCount += 1;
          lastPossibleOpenMs = evtMs;
        }
      }
    } else if (evt.type === "CLICK") {
      const isSelf = Boolean(evt.suspectedSelfOpen || evt.classification === "SELF_LIKELY");
      const ua = evt.userAgent;
      const detectedSource = ua ? detectOpenRequestSource(ua) : null;
      const isMachine = evt.classification === "MACHINE_LIKELY" || detectedSource === "headless" || detectedSource === "scanner";
      const isExplicitNonRecipient = isSelf || isMachine || evt.classification === "UNKNOWN";

      const isRecipientClick =
        evt.classification === "RECIPIENT_LIKELY" ||
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

export function publicTrackerOrigin(siteUrl: string | undefined, requestUrl: string): string {
  const configured = (siteUrl || '').replace(/\/$/, '');
  if (configured.includes('.convex.site')) return configured;
  let origin = '';
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    origin = '';
  }
  if (origin.includes('.convex.cloud')) return origin.replace('.convex.cloud', '.convex.site');
  return configured || origin;
}
