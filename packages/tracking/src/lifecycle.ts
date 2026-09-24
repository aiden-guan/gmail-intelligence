/** Open classification and tracker health. No Gmail or network side effects. */

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

export type OpenVerdict = {
  classification: OpenClassification;
  suspected: boolean;
  confidence: number;
  /** Verified countable recipient open. */
  countsAsOpen: boolean;
  source: OpenRequestSource;
};

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

/**
 * Classify a pixel fetch against the real send time and request source.
 */
export function classifyOpenEvent(opts: {
  eventTs: number;
  sentAt: number | null;
  userAgent?: string | null;
  ipHash?: string | null;
  selfViewTs?: number | null;
}): OpenVerdict {
  const sentAt = opts.sentAt;
  const source = detectOpenRequestSource(opts.userAgent);

  // Pre-send fetches (composer / draft previews)
  if (sentAt == null || !Number.isFinite(sentAt) || opts.eventTs < sentAt) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  // Correlated sender self-view takes precedence and MUST NOT count
  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.eventTs, opts.selfViewTs)) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  // Machine / Proxy fetches
  if (source === 'google_image_proxy') {
    return {
      classification: 'PROXY_LIKELY',
      suspected: true,
      confidence: 0.8,
      countsAsOpen: false,
      source,
    };
  }

  if (source === 'headless' || source === 'scanner') {
    return {
      classification: 'MACHINE_LIKELY',
      suspected: true,
      confidence: 0.9,
      countsAsOpen: false,
      source,
    };
  }

  if (source === 'unknown') {
    return {
      classification: 'UNKNOWN',
      suspected: true,
      confidence: 0.5,
      countsAsOpen: false,
      source,
    };
  }

  // Fast recipient open without SELF_VIEW or machine/proxy signals counts as recipient open
  return {
    classification: 'RECIPIENT_LIKELY',
    suspected: false,
    confidence: 0,
    countsAsOpen: true,
    source,
  };
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
  /** Verified countable recipient click. */
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

  // Pre-send clicks (composer / draft preview)
  if (sentAt == null || !Number.isFinite(sentAt) || opts.eventTs < sentAt) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Correlated sender self-view takes precedence
  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.eventTs, opts.selfViewTs)) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Machine / scanner fetches (e.g. security scanners inspecting links)
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
  userAgent?: string | null;
  user_agent?: string | null;
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

      const ua = evt.userAgent || evt.user_agent;
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
      const ua = evt.userAgent || evt.user_agent;
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

/** InboxSDK and Gmail use several id spellings for the same thread or message. */
export function normalizeGmailId(value: string | null | undefined): string | null {
  if (!value) return null;
  const next = value.trim().replace(/^#/, '').replace(/^(msg-a:|msg-f:|thread-a:|thread-f:)/i, '');
  return next || null;
}

export type TrackerHealthStatus =
  | 'disabled'
  | 'missing'
  | 'invalid_url'
  | 'unauthorized'
  | 'unreachable'
  | 'healthy';

export type TrackerProbe = {
  status: TrackerHealthStatus;
  label: string;
};

export function trackerHealthLabel(status: TrackerHealthStatus): string {
  switch (status) {
    case 'disabled':
      return 'Disabled';
    case 'missing':
      return 'Missing configuration';
    case 'invalid_url':
      return 'Invalid URL';
    case 'unauthorized':
      return 'Unauthorized token';
    case 'unreachable':
      return 'Tracker unreachable';
    case 'healthy':
      return 'Tracker healthy';
  }
}

export async function probeTracker(
  baseUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<TrackerProbe> {
  const trimmedUrl = baseUrl.trim();
  const trimmedToken = token.trim();
  if (!trimmedUrl || !trimmedToken) return { status: 'missing', label: trackerHealthLabel('missing') };
  let origin = '';
  try {
    const url = new URL(trimmedUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { status: 'invalid_url', label: trackerHealthLabel('invalid_url') };
    }
    origin = url.origin;
  } catch {
    return { status: 'invalid_url', label: trackerHealthLabel('invalid_url') };
  }
  const health = await requestOk(fetcher, `${origin}/health`);
  if (health === 'unreachable') return { status: 'unreachable', label: trackerHealthLabel('unreachable') };
  const authed = await requestOk(fetcher, `${origin}/api/emails?limit=1`, {
    Authorization: `Bearer ${trimmedToken}`,
  });
  if (authed === 'unauthorized') return { status: 'unauthorized', label: trackerHealthLabel('unauthorized') };
  if (authed === 'unreachable') return { status: 'unreachable', label: trackerHealthLabel('unreachable') };
  return { status: 'healthy', label: trackerHealthLabel('healthy') };
}

async function requestOk(
  fetcher: typeof fetch,
  url: string,
  headers?: HeadersInit,
): Promise<'ok' | 'unauthorized' | 'unreachable'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetcher(url, { headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    return response.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

export type TrackingSendReport = {
  composeSessionId: string;
  kind: string;
  state: string;
  trackingId: string | null;
  allocation: boolean;
  draftId: boolean;
  modifierRegistered: boolean;
  modifierInvoked: boolean;
  pixelPresent: boolean;
  gmailSent: boolean;
  gmailIdsLinked: boolean;
  lastError: string | null;
  logs: Array<{ event: string; detail: string }>;
};

export type TrackingPixelEventDiagnostic = {
  trackingId: string;
  eventType: string;
  classification: OpenClassification;
  requestSource: OpenRequestSource;
  userAgentCategory: string;
  timestamp: string;
  sentAt: string | null;
  selfViewCorrelated: boolean;
  countsAsOpen: boolean;
};

export type TrackingDiagnosticsReport = {
  health: TrackerHealthStatus;
  endpoint: string;
  auth: string;
  inboxSdk: string;
  pageWorld: string;
  composeHook: string;
  last: TrackingSendReport | null;
  lastPixelEvent?: TrackingPixelEventDiagnostic | null;
};

export function formatTrackingReport(report: TrackingDiagnosticsReport): string {
  const last = report.last;
  const yes = (value: boolean | undefined) => (value ? 'yes' : 'no');
  const lines = [
    `Tracking: ${trackerHealthLabel(report.health)}`,
    '',
    `Tracker endpoint: ${report.endpoint}`,
    `Tracker auth: ${report.auth}`,
    `InboxSDK: ${report.inboxSdk}`,
    `Page world: ${report.pageWorld}`,
    `Compose hook: ${report.composeHook}`,
    '',
    'Last tracked send:',
    `  allocation: ${yes(last?.allocation)}`,
    `  draft ID: ${yes(last?.draftId)}`,
    `  modifier registered: ${yes(last?.modifierRegistered)}`,
    `  modifier invoked: ${yes(last?.modifierInvoked)}`,
    `  pixel returned in outbound HTML: ${yes(last?.pixelPresent)}`,
    `  Gmail sent event: ${yes(last?.gmailSent)}`,
    `  Gmail IDs linked: ${yes(last?.gmailIdsLinked)}`,
    '',
    `Last tracking ID:`,
    `  ${last?.trackingId || 'none'}`,
    '',
    `Last failure:`,
    `  ${last?.lastError || 'none'}`,
  ];
  if (last?.modifierRegistered && !last.modifierInvoked && last.gmailSent) {
    lines.push(
      '',
      'Tracking injection failed:',
      'InboxSDK request modifier was registered but was never invoked for Gmail send.',
    );
  }
  if (report.lastPixelEvent) {
    lines.push(
      '',
      'Last pixel request:',
      `  tracking ID: ${report.lastPixelEvent.trackingId}`,
      `  source: ${report.lastPixelEvent.requestSource}`,
      `  classification: ${report.lastPixelEvent.classification}`,
      `  counted as recipient open: ${report.lastPixelEvent.countsAsOpen ? 'yes' : 'no'}`,
      `  self-view correlated: ${report.lastPixelEvent.selfViewCorrelated ? 'yes' : 'no'}`,
      `  timestamp: ${report.lastPixelEvent.timestamp}`,
    );
  }
  if (last?.logs.length) {
    lines.push('', 'Recent log:');
    for (const entry of last.logs.slice(-8)) {
      lines.push(`  ${entry.event}${entry.detail ? ` ${entry.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

export type MimeTrackingInspection = {
  pixelFound: boolean;
  trackingIds: string[];
  pixelCount: number;
  trackedLinks: number;
};

/** Inspect raw MIME or an exported .eml. Does not call Gmail. */
export function inspectTrackedMime(raw: string): MimeTrackingInspection {
  const ids = new Set<string>();
  let pixelCount = 0;
  for (const match of raw.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'][^"']*\/open\/(trk_[A-Za-z0-9_-]+)/gi)) {
    pixelCount += 1;
    if (match[1]) ids.add(match[1].replace(/\.(gif|png|jpe?g|webp)$/i, ''));
  }
  if (pixelCount === 0) {
    for (const match of raw.matchAll(/\/open\/(trk_[A-Za-z0-9_-]+)/gi)) {
      if (match[1]) ids.add(match[1].replace(/\.(gif|png|jpe?g|webp)$/i, ''));
    }
  }
  const trackedLinks = raw.match(/\/c\/clk_[A-Za-z0-9_-]+/gi)?.length || 0;
  return {
    pixelFound: pixelCount > 0 || ids.size > 0,
    trackingIds: [...ids],
    pixelCount: pixelCount || (ids.size > 0 ? ids.size : 0),
    trackedLinks,
  };
}
