import { z } from 'zod';

/**
 * Tracking client — talks ONLY to the tracker worker.
 * Mailbox contents must NEVER be sent here.
 * Send mail through Gmail normally; tracking injects pixel/links only.
 */

export const TrackedEmailSchema = z.object({
  tracking_id: z.string().min(8),
  subject: z.string(),
  sender: z.string(),
  recipients: z.array(z.string()),
  gmail_thread_id: z.string().optional(),
  gmail_message_id: z.string().optional(),
  sent_at: z.string(),
  first_opened_at: z.string().nullable().optional(),
  last_opened_at: z.string().nullable().optional(),
  open_count: z.number().default(0),
  first_clicked_at: z.string().nullable().optional(),
  last_clicked_at: z.string().nullable().optional(),
  click_count: z.number().default(0),
});
export type TrackedEmail = z.infer<typeof TrackedEmailSchema>;

export const TrackingEventSchema = z.object({
  id: z.string(),
  tracking_id: z.string(),
  type: z.enum(['OPEN', 'CLICK']),
  timestamp: z.string(),
  user_agent: z.string().optional(),
  ip_hash: z.string().optional(),
  suspected_self_open: z.boolean().optional(),
  confidence: z.number().optional(),
  click_id: z.string().optional(),
  destination: z.string().optional(),
});
export type TrackingEvent = z.infer<typeof TrackingEventSchema>;

export type CreateTrackedEmailInput = {
  subject: string;
  sender: string;
  recipients: string[];
  gmail_thread_id?: string;
  gmail_message_id?: string;
  links?: Array<{ url: string }>;
};

export type CreateTrackedEmailResult = {
  tracking_id: string;
  pixel_url: string;
  rewritten_links: Array<{ click_id: string; original: string; tracked_url: string }>;
};

export class TrackingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  async createEmail(input: CreateTrackedEmailInput): Promise<CreateTrackedEmailResult> {
    const res = await fetch(`${trim(this.baseUrl)}/api/emails`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`tracking create failed: ${res.status}`);
    return res.json() as Promise<CreateTrackedEmailResult>;
  }

  async getEmail(id: string): Promise<TrackedEmail> {
    const res = await fetch(`${trim(this.baseUrl)}/api/emails/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`tracking get failed: ${res.status}`);
    return res.json() as Promise<TrackedEmail>;
  }

  async getEvents(id: string): Promise<TrackingEvent[]> {
    const res = await fetch(
      `${trim(this.baseUrl)}/api/emails/${encodeURIComponent(id)}/events`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`tracking events failed: ${res.status}`);
    return res.json() as Promise<TrackingEvent[]>;
  }

  async getRecentEvents(): Promise<TrackingEvent[]> {
    const res = await fetch(`${trim(this.baseUrl)}/api/events/recent`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`tracking recent failed: ${res.status}`);
    return res.json() as Promise<TrackingEvent[]>;
  }
}

/** Build pixel HTML to inject into compose — does not send mail. */
export function buildTrackingPixelHtml(pixelUrl: string): string {
  return `<img src="${escapeAttr(pixelUrl)}" width="1" height="1" alt="" style="display:none!important;width:1px;height:1px;border:0;" />`;
}

/**
 * Rewrite only http(s) links. Never mailto, tel, javascript, anchors,
 * tracking URLs, or Gmail internal links.
 */
export function shouldRewriteLink(href: string): boolean {
  const h = href.trim();
  if (!/^https?:\/\//i.test(h)) return false;
  if (/^mailto:/i.test(h) || /^tel:/i.test(h) || /^javascript:/i.test(h)) return false;
  if (h.startsWith('#')) return false;
  if (/mail\.google\.com/i.test(h)) return false;
  if (/\/open\//i.test(h) || /\/c\//i.test(h)) return false;
  return true;
}

export function rewriteHtmlLinks(
  html: string,
  map: Map<string, string>,
): string {
  return html.replace(/href=(["'])(.*?)\1/gi, (full, quote: string, url: string) => {
    if (!shouldRewriteLink(url)) return full;
    const tracked = map.get(url);
    if (!tracked) return full;
    return `href=${quote}${tracked}${quote}`;
  });
}

export function formatSentTrackingBadge(email: {
  open_count: number;
  click_count: number;
}): string {
  if (email.open_count <= 0 && email.click_count <= 0) {
    return '✓ tracking enabled · no open detected';
  }
  if (email.click_count > 0) {
    return `✓✓ ${email.open_count} · Link ${email.click_count}`;
  }
  return `✓✓ open detected${email.open_count > 1 ? ` (${email.open_count})` : ''}`;
}

export function isLikelySelfOpen(opts: {
  eventTs: number;
  sentAt: number;
  userAgent?: string;
  senderActiveRecently?: boolean;
  ipHashMatchesSender?: boolean;
}): { suspected: boolean; confidence: number } {
  const delta = opts.eventTs - opts.sentAt;
  let score = 0;
  if (delta >= 0 && delta < 5_000) score += 0.5;
  if (opts.senderActiveRecently) score += 0.3;
  if (opts.ipHashMatchesSender) score += 0.3;
  if (opts.userAgent && /Chrome-Lighthouse|Headless/i.test(opts.userAgent)) score += 0.2;
  return { suspected: score >= 0.5, confidence: Math.min(1, score) };
}

function trim(s: string): string {
  return s.replace(/\/$/, '');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
