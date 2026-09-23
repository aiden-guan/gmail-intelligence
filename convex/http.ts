import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const TRANSPARENT_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function gif(): Response {
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

function authorized(request: Request): boolean {
  const token = process.env.PERSONAL_API_TOKEN || "";
  const header = request.headers.get("Authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(token) && presented === token;
}

function safeRedirectUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function suspectSelfOpen(sentAt: string | null, now: number, ua: string | null): { suspected: boolean; confidence: number } {
  let score = 0;
  if (sentAt) {
    const delta = now - Date.parse(sentAt);
    if (delta >= 0 && delta < 5000) score += 0.5;
  }
  if (ua && /Headless|Lighthouse/i.test(ua)) score += 0.3;
  return { suspected: score >= 0.5, confidence: Math.min(1, score) };
}

async function hashIp(ip: string): Promise<string | null> {
  if (!ip) return null;
  const salt = process.env.PERSONAL_API_TOKEN || "salt";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function validId(id: string): boolean {
  return Boolean(id) && id.length <= 80 && /^[\w-]+$/.test(id);
}

type EmailDoc = {
  trackingId: string;
  subject: string;
  sender: string;
  recipients: string[];
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  sentAt: string;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  firstClickedAt: string | null;
  lastClickedAt: string | null;
  clickCount: number;
};

type EventDoc = {
  eventId: string;
  trackingId: string;
  type: "OPEN" | "CLICK";
  timestamp: string;
  userAgent: string | null;
  ipHash: string | null;
  suspectedSelfOpen: boolean;
  confidence: number;
  clickId: string | null;
  destination: string | null;
};

function emailJson(row: EmailDoc) {
  return {
    tracking_id: row.trackingId,
    subject: row.subject,
    sender: row.sender,
    recipients: row.recipients,
    gmail_thread_id: row.gmailThreadId,
    gmail_message_id: row.gmailMessageId,
    sent_at: row.sentAt,
    first_opened_at: row.firstOpenedAt,
    last_opened_at: row.lastOpenedAt,
    open_count: row.openCount,
    first_clicked_at: row.firstClickedAt,
    last_clicked_at: row.lastClickedAt,
    click_count: row.clickCount,
  };
}

function eventJson(row: EventDoc) {
  return {
    id: row.eventId,
    tracking_id: row.trackingId,
    type: row.type,
    timestamp: row.timestamp,
    user_agent: row.userAgent,
    ip_hash: row.ipHash,
    suspected_self_open: row.suspectedSelfOpen,
    confidence: row.confidence,
    click_id: row.clickId,
    destination: row.destination,
  };
}

const http = httpRouter();

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => json({ ok: true, store: "convex" })),
});

http.route({
  pathPrefix: "/open/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const trackingId = decodeURIComponent(new URL(request.url).pathname.slice("/open/".length));
    if (!validId(trackingId)) return gif();
    try {
      const email = await ctx.runQuery(internal.tracking.getEmail, { trackingId });
      if (email) {
        const now = Date.now();
        const ua = request.headers.get("User-Agent");
        const self = suspectSelfOpen(email.sentAt, now, ua);
        await ctx.runMutation(internal.tracking.recordOpen, {
          eventId: newId("evt"),
          trackingId,
          type: "OPEN",
          timestamp: new Date(now).toISOString(),
          userAgent: ua,
          ipHash: await hashIp(clientIp(request)),
          suspectedSelfOpen: self.suspected,
          confidence: self.confidence,
          clickId: null,
          destination: null,
        });
      }
    } catch (error) {
      console.error("open record failed", error);
    }
    return gif();
  }),
});

http.route({
  pathPrefix: "/c/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const clickId = decodeURIComponent(new URL(request.url).pathname.slice("/c/".length));
    if (!validId(clickId)) return json({ error: "bad_id" }, 400);
    const link = await ctx.runQuery(internal.tracking.getLink, { clickId });
    if (!link) return json({ error: "not_found" }, 404);
    const destination = safeRedirectUrl(link.destination);
    if (!destination) return json({ error: "bad_destination" }, 400);
    try {
      const ua = request.headers.get("User-Agent");
      await ctx.runMutation(internal.tracking.recordClick, {
        eventId: newId("evt"),
        trackingId: link.trackingId,
        type: "CLICK",
        timestamp: new Date().toISOString(),
        userAgent: ua,
        ipHash: await hashIp(clientIp(request)),
        suspectedSelfOpen: false,
        confidence: 0.5,
        clickId,
        destination,
      });
    } catch (error) {
      console.error("click record failed", error);
    }
    return Response.redirect(destination, 302);
  }),
});

http.route({
  pathPrefix: "/api/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/emails") {
      const raw = Number(url.searchParams.get("limit") || "100");
      const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.floor(raw))) : 100;
      const rows = await ctx.runQuery(internal.tracking.listEmails, { limit });
      return json(rows.map(emailJson));
    }
    if (path === "/api/events/recent") {
      const rows = await ctx.runQuery(internal.tracking.recentEvents, {});
      return json(rows.map(eventJson));
    }
    if (path.startsWith("/api/emails/") && path.endsWith("/events")) {
      const id = decodeURIComponent(path.slice("/api/emails/".length, -"/events".length));
      if (!validId(id)) return json({ error: "bad_id" }, 400);
      const rows = await ctx.runQuery(internal.tracking.listEvents, { trackingId: id });
      return json(rows.map(eventJson));
    }
    if (path.startsWith("/api/emails/")) {
      const id = decodeURIComponent(path.slice("/api/emails/".length));
      if (!validId(id)) return json({ error: "bad_id" }, 400);
      const row = await ctx.runQuery(internal.tracking.getEmail, { trackingId: id });
      if (!row) return json({ error: "not_found" }, 404);
      return json(emailJson(row));
    }
    return json({ error: "not_found" }, 404);
  }),
});

http.route({
  path: "/api/emails",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const body = (await request.json().catch(() => null)) as {
      subject?: unknown;
      sender?: unknown;
      recipients?: unknown;
      gmail_thread_id?: unknown;
      gmail_message_id?: unknown;
      links?: unknown;
    } | null;
    if (!body || typeof body.subject !== "string" || typeof body.sender !== "string" || !Array.isArray(body.recipients)) {
      return json({ error: "bad_request" }, 400);
    }
    const recipients = body.recipients.filter((item): item is string => typeof item === "string").slice(0, 100);
    if (!recipients.length || body.subject.length > 998) return json({ error: "bad_request" }, 400);
    const trackingId = newId("trk");
    const sentAt = new Date().toISOString();
    const origin = process.env.CONVEX_SITE_URL?.replace(/\/$/, "") || new URL(request.url).origin;
    const links: Array<{ clickId: string; destination: string }> = [];
    const rewritten: Array<{ click_id: string; original: string; tracked_url: string }> = [];
    if (Array.isArray(body.links)) {
      for (const link of body.links.slice(0, 50)) {
        const raw = link && typeof link === "object" && "url" in link ? String((link as { url: unknown }).url) : "";
        const safe = safeRedirectUrl(raw);
        if (!safe) continue;
        const clickId = newId("clk");
        links.push({ clickId, destination: safe });
        rewritten.push({ click_id: clickId, original: safe, tracked_url: `${origin}/c/${clickId}` });
      }
    }
    await ctx.runMutation(internal.tracking.createEmail, {
      trackingId,
      subject: body.subject,
      sender: body.sender.slice(0, 320),
      recipients,
      gmailThreadId: typeof body.gmail_thread_id === "string" ? body.gmail_thread_id.slice(0, 128) : null,
      gmailMessageId: typeof body.gmail_message_id === "string" ? body.gmail_message_id.slice(0, 128) : null,
      sentAt,
      links,
    });
    return json({
      tracking_id: trackingId,
      pixel_url: `${origin}/open/${trackingId}`,
      rewritten_links: rewritten,
    });
  }),
});

http.route({
  pathPrefix: "/api/emails/",
  method: "PATCH",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const id = decodeURIComponent(new URL(request.url).pathname.slice("/api/emails/".length));
    if (!validId(id) || id.includes("/")) return json({ error: "bad_id" }, 400);
    const body = (await request.json().catch(() => null)) as {
      gmail_thread_id?: unknown;
      gmail_message_id?: unknown;
    } | null;
    if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);
    const patch: { trackingId: string; gmailThreadId?: string | null; gmailMessageId?: string | null } = { trackingId: id };
    if ("gmail_thread_id" in body) {
      patch.gmailThreadId = body.gmail_thread_id == null ? null : String(body.gmail_thread_id).slice(0, 128);
    }
    if ("gmail_message_id" in body) {
      patch.gmailMessageId = body.gmail_message_id == null ? null : String(body.gmail_message_id).slice(0, 128);
    }
    const row = await ctx.runMutation(internal.tracking.patchEmail, patch);
    if (!row) return json({ error: "not_found" }, 404);
    return json(emailJson(row));
  }),
});

export default http;
