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
