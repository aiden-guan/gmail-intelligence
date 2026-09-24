/** Open classification and tracker health. No Gmail or network side effects. */

export type OpenClassification = 'RECIPIENT_LIKELY' | 'SELF_LIKELY' | 'UNKNOWN';

export type OpenVerdict = {
  classification: OpenClassification;
  suspected: boolean;
  confidence: number;
  /** Pre-send fetches are stored and are not recipient opens. */
  countsAsOpen: boolean;
};

/**
 * Classify a pixel fetch against the real send time.
 * Events before `sentAt` are self/composer traffic. Events a few seconds
 * after send are suspected, and still count, so a fast recipient open is kept.
 */
export function classifyOpenEvent(opts: {
  eventTs: number;
  sentAt: number | null;
  userAgent?: string | null;
}): OpenVerdict {
  const sentAt = opts.sentAt;
  if (sentAt == null || !Number.isFinite(sentAt) || opts.eventTs < sentAt) {
    return { classification: 'SELF_LIKELY', suspected: true, confidence: 1, countsAsOpen: false };
  }
  const delta = opts.eventTs - sentAt;
  if (delta < 5_000) {
    return { classification: 'SELF_LIKELY', suspected: true, confidence: 0.5, countsAsOpen: true };
  }
  if (opts.userAgent && /Headless|Lighthouse|Chrome-Lighthouse/i.test(opts.userAgent)) {
    return { classification: 'UNKNOWN', suspected: true, confidence: 0.3, countsAsOpen: true };
  }
  return { classification: 'RECIPIENT_LIKELY', suspected: false, confidence: 0, countsAsOpen: true };
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

export type TrackingDiagnosticsReport = {
  health: TrackerHealthStatus;
  endpoint: string;
  auth: string;
  inboxSdk: string;
  pageWorld: string;
  composeHook: string;
  last: TrackingSendReport | null;
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
