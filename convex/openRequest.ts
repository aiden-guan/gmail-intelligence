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

export type OpenClassification = "RECIPIENT_LIKELY" | "SELF_LIKELY" | "UNKNOWN";

export function classifyOpenEvent(opts: {
  eventTs: number;
  sentAt: number | null;
  userAgent?: string | null;
}): { classification: OpenClassification; suspected: boolean; confidence: number; countsAsOpen: boolean } {
  if (opts.sentAt == null || !Number.isFinite(opts.sentAt) || opts.eventTs < opts.sentAt) {
    return { classification: "SELF_LIKELY", suspected: true, confidence: 1, countsAsOpen: false };
  }
  const delta = opts.eventTs - opts.sentAt;
  if (delta < 5000) {
    return { classification: "SELF_LIKELY", suspected: true, confidence: 0.5, countsAsOpen: true };
  }
  if (opts.userAgent && /Headless|Lighthouse/i.test(opts.userAgent)) {
    return { classification: "UNKNOWN", suspected: true, confidence: 0.3, countsAsOpen: true };
  }
  return { classification: "RECIPIENT_LIKELY", suspected: false, confidence: 0, countsAsOpen: true };
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
