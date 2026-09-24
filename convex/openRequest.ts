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
