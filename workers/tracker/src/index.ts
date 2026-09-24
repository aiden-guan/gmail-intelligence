import { z } from 'zod';
import { safeRedirectUrl, classifyOpen } from './helpers.js';
import { getStore, StoreError, type EmailRow, type TrackerStore } from './store.js';

export { safeRedirectUrl, classifyOpen, suspectSelfOpen } from './helpers.js';

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PERSONAL_API_TOKEN?: string;
}

const TRANSPARENT_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0),
);

const PatchEmailSchema = z
  .object({
    gmail_thread_id: z.string().max(128).nullable().optional(),
    gmail_message_id: z.string().max(128).nullable().optional(),
    status: z.enum(['PENDING', 'SENT', 'CANCELLED', 'FAILED']).optional(),
    sent_at: z.string().max(40).nullable().optional(),
    subject: z.string().max(998).optional(),
    sender: z.string().max(320).optional(),
    recipients: z.array(z.string().max(320)).max(100).optional(),
    links: z
      .array(z.object({ click_id: z.string().regex(/^[\w-]+$/).max(80), url: z.string().url() }))
      .max(50)
      .optional(),
  })
  .strict();

const CreateEmailSchema = z.object({
  subject: z.string().max(998),
  sender: z.string().max(320),
  recipients: z.array(z.string().max(320)).min(1).max(100),
  gmail_thread_id: z.string().max(128).optional(),
  gmail_message_id: z.string().max(128).optional(),
  links: z.array(z.object({ url: z.string().url() })).max(50).optional(),
});

function requireAuth(req: Request, env: Env): Response | null {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.PERSONAL_API_TOKEN || token !== env.PERSONAL_API_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function gifResponse(): Response {
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });
}

async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function storeFailure(err: unknown): Response | null {
  if (err instanceof StoreError) return json({ error: err.message }, 500);
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const store = getStore(env);

    try {
      // Public pixel
      if (request.method === 'GET' && path.startsWith('/open/')) {
        return handleOpen(path.slice('/open/'.length), request, env, store);
      }
      // Public click
      if (request.method === 'GET' && path.startsWith('/c/')) {
        return handleClick(path.slice('/c/'.length), request, env, store);
      }

      // Private management
      if (path.startsWith('/api/')) {
        const denied = requireAuth(request, env);
        if (denied) return denied;

        if (request.method === 'POST' && path === '/api/emails') {
          return handleCreateEmail(request, env, url.origin, store);
        }
        if (request.method === 'GET' && path === '/api/emails') {
          return handleListEmails(url, store);
        }
        if (request.method === 'PATCH' && path.startsWith('/api/emails/')) {
          return handlePatchEmail(path.slice('/api/emails/'.length), request, store);
        }
        if (request.method === 'POST' && path.startsWith('/api/emails/') && path.endsWith('/self-view')) {
          const id = path.slice('/api/emails/'.length, -'/self-view'.length);
          return handleSelfView(id, request, env, store);
        }
        if (request.method === 'GET' && path.startsWith('/api/emails/') && path.endsWith('/events')) {
          const id = path.slice('/api/emails/'.length, -'/events'.length);
          return handleGetEvents(id, store);
        }
        if (request.method === 'GET' && path.startsWith('/api/emails/')) {
          const id = path.slice('/api/emails/'.length);
          return handleGetEmail(id, store);
        }
        if (request.method === 'GET' && path === '/api/events/recent') {
          return handleRecentEvents(store);
        }
      }

      if (path === '/health') {
        return json({ ok: true, store: store.kind });
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      const failed = storeFailure(err);
      if (failed) return failed;
      console.error(err);
      return json({ error: 'internal' }, 500);
    }
  },
};

async function handleCreateEmail(
  request: Request,
  _env: Env,
  origin: string,
  store: TrackerStore,
): Promise<Response> {
  const body = CreateEmailSchema.parse(await request.json());
  const tracking_id = newId('trk');
  const created_at = new Date().toISOString();

  const email: EmailRow = {
    tracking_id,
    status: 'PENDING',
    subject: body.subject,
    sender: body.sender,
    recipients: body.recipients,
    gmail_thread_id: body.gmail_thread_id ?? null,
    gmail_message_id: body.gmail_message_id ?? null,
    sent_at: null,
    first_opened_at: null,
    last_opened_at: null,
    open_count: 0,
    first_clicked_at: null,
    last_clicked_at: null,
    click_count: 0,
    created_at,
  };
  await store.insertEmail(email);

  const rewritten_links: Array<{ click_id: string; original: string; tracked_url: string }> = [];
  for (const link of body.links || []) {
    const safe = safeRedirectUrl(link.url);
    if (!safe) continue;
    const click_id = newId('clk');
    await store.insertLink({
      click_id,
      tracking_id,
      destination: safe,
    });
    rewritten_links.push({
      click_id,
      original: safe,
      tracked_url: `${origin}/c/${click_id}`,
    });
  }

  return json({
    tracking_id,
    pixel_url: `${origin}/open/${tracking_id}`,
    status: 'PENDING',
    created_at,
    sent_at: null,
    rewritten_links,
  });
}

async function handleGetEmail(id: string, store: TrackerStore): Promise<Response> {
  if (!id || id.length > 80) return json({ error: 'bad_id' }, 400);
  const data = await store.getEmail(id);
  if (!data) return json({ error: 'not_found' }, 404);
  return json(data);
}

async function handleListEmails(url: URL, store: TrackerStore): Promise<Response> {
  const raw = Number(url.searchParams.get('limit') || '100');
  const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.floor(raw))) : 100;
  return json(await store.listEmails(limit));
}

async function handlePatchEmail(
  id: string,
  request: Request,
  store: TrackerStore,
): Promise<Response> {
  if (!id || id.length > 80 || id.includes('/') || !/^[\w-]+$/.test(id)) {
    return json({ error: 'bad_id' }, 400);
  }
  const parsed = PatchEmailSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'bad_request' }, 400);
  const existing = await store.getEmail(id);
  if (!existing) return json({ error: 'not_found' }, 404);
  const patch: Partial<EmailRow> = {};
  if (parsed.data.gmail_thread_id !== undefined) patch.gmail_thread_id = parsed.data.gmail_thread_id;
  if (parsed.data.gmail_message_id !== undefined) patch.gmail_message_id = parsed.data.gmail_message_id;
  if (parsed.data.subject !== undefined) patch.subject = parsed.data.subject;
  if (parsed.data.sender !== undefined) patch.sender = parsed.data.sender;
  if (parsed.data.recipients !== undefined) patch.recipients = parsed.data.recipients;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  if (parsed.data.sent_at !== undefined) patch.sent_at = parsed.data.sent_at;
  if (patch.status === 'SENT' && patch.sent_at === undefined && !existing.sent_at) {
    patch.sent_at = new Date().toISOString();
  }
  if (Object.keys(patch).length > 0) await store.updateEmail(id, patch);
  for (const link of parsed.data.links || []) {
    const safe = safeRedirectUrl(link.url);
    if (!safe) continue;
    const already = await store.getLink(link.click_id);
    if (already) continue;
    await store.insertLink({ click_id: link.click_id, tracking_id: id, destination: safe });
  }
  return json(await store.getEmail(id));
}

async function handleGetEvents(id: string, store: TrackerStore): Promise<Response> {
  if (!id || id.length > 80) return json({ error: 'bad_id' }, 400);
  return json(await store.listEvents(id));
}

async function handleRecentEvents(store: TrackerStore): Promise<Response> {
  return json(await store.recentEvents());
}

async function recomputeEmailStats(trackingId: string, store: TrackerStore): Promise<EmailRow | null> {
  const events = await store.listEvents(trackingId);
  const sorted = [...events].sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));
  let openCount = 0;
  let firstOpenedAt: string | null = null;
  let lastOpenedAt: string | null = null;
  let lastValidMs = 0;

  for (const evt of sorted) {
    if (evt.type === 'OPEN' && !evt.suspected_self_open && evt.classification !== 'SELF_LIKELY') {
      const evtMs = Date.parse(evt.timestamp);
      if (lastValidMs && Number.isFinite(evtMs) && evtMs >= lastValidMs && evtMs - lastValidMs < 800) {
        continue;
      }
      openCount += 1;
      lastValidMs = evtMs;
      if (!firstOpenedAt) firstOpenedAt = evt.timestamp;
      lastOpenedAt = evt.timestamp;
    }
  }

  const patch: Partial<EmailRow> = {
    open_count: openCount,
    first_opened_at: firstOpenedAt,
    last_opened_at: lastOpenedAt,
  };
  await store.updateEmail(trackingId, patch);
  return store.getEmail(trackingId);
}

async function handleSelfView(
  id: string,
  request: Request,
  _env: Env,
  store: TrackerStore,
): Promise<Response> {
  if (!id || id.length > 80 || id.includes('/') || !/^[\w-]+$/.test(id)) {
    return json({ error: 'bad_id' }, 400);
  }
  const existing = await store.getEmail(id);
  if (!existing) return json({ error: 'not_found' }, 404);

  const body = (await request.json().catch(() => ({}))) as { timestamp?: string; gmailThreadId?: string | null };
  const ts = body.timestamp && !Number.isNaN(Date.parse(body.timestamp))
    ? new Date(body.timestamp).toISOString()
    : new Date().toISOString();
  const selfMs = Date.parse(ts);

  if (body.gmailThreadId && !existing.gmail_thread_id) {
    await store.updateEmail(id, { gmail_thread_id: body.gmailThreadId });
  }

  await store.insertEvent({
    id: newId('evt'),
    tracking_id: id,
    type: 'SELF_VIEW',
    timestamp: ts,
    user_agent: request.headers.get('User-Agent'),
    ip_hash: null,
    suspected_self_open: true,
    confidence: 1,
    classification: 'SELF_LIKELY',
  });

  const events = await store.listEvents(id);
  for (const evt of events) {
    if (evt.type === 'OPEN') {
      const openMs = Date.parse(evt.timestamp);
      if (Number.isFinite(openMs) && Math.abs(openMs - selfMs) < 15_000) {
        await store.updateEvent(evt.id, {
          classification: 'SELF_LIKELY',
          suspected_self_open: true,
          confidence: 1,
        });
      }
    }
  }

  const updated = await recomputeEmailStats(id, store);
  return json({ ok: true, open_count: updated?.open_count ?? 0 });
}

async function handleOpen(
  trackingId: string,
  request: Request,
  env: Env,
  store: TrackerStore,
): Promise<Response> {
  // Always return the GIF. Recording is best-effort.
  if (!trackingId || trackingId.length > 80 || !/^[\w-]+$/.test(trackingId)) {
    return gifResponse();
  }

  try {
    const email = await store.getEmail(trackingId);

    if (email) {
      const ua = request.headers.get('User-Agent');
      const ip =
        request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
        '';
      const ip_hash = ip ? await hashIp(ip, env.PERSONAL_API_TOKEN || 'salt') : null;
      const now = Date.now();

      const events = await store.listEvents(trackingId);
      const recentSelfView = events.find(
        (e) => e.type === 'SELF_VIEW' && Math.abs(now - Date.parse(e.timestamp)) < 15_000,
      );
      const selfViewTs = recentSelfView ? Date.parse(recentSelfView.timestamp) : null;

      const verdict = classifyOpen({ sentAt: email.sent_at, now, ua, selfViewTs });
      const ts = new Date(now).toISOString();
      const lastMs = email.last_opened_at ? Date.parse(email.last_opened_at) : 0;
      const duplicate = verdict.countsAsOpen && lastMs && Number.isFinite(now) && now >= lastMs && now - lastMs < 800;
      if (!duplicate) {
        await store.insertEvent({
          id: newId('evt'),
          tracking_id: trackingId,
          type: 'OPEN',
          timestamp: ts,
          user_agent: ua,
          ip_hash,
          suspected_self_open: verdict.suspected,
          confidence: verdict.confidence,
          classification: verdict.classification,
        });
        if (verdict.countsAsOpen) {
          const open_count = (email.open_count || 0) + 1;
          const patch: Partial<EmailRow> = {
            open_count,
            last_opened_at: ts,
          };
          if (open_count === 1) patch.first_opened_at = ts;
          await store.updateEmail(trackingId, patch);
        }
      }
    }
  } catch (e) {
    console.error('open record failed', e);
  }

  return gifResponse();
}

async function handleClick(
  clickId: string,
  request: Request,
  env: Env,
  store: TrackerStore,
): Promise<Response> {
  if (!clickId || clickId.length > 80 || !/^[\w-]+$/.test(clickId)) {
    return json({ error: 'bad_id' }, 400);
  }

  const link = await store.getLink(clickId);
  if (!link) return json({ error: 'not_found' }, 404);

  const destination = safeRedirectUrl(link.destination);
  if (!destination) return json({ error: 'bad_destination' }, 400);

  try {
    const ua = request.headers.get('User-Agent');
    const ip =
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
      '';
    const ip_hash = ip ? await hashIp(ip, env.PERSONAL_API_TOKEN || 'salt') : null;
    const ts = new Date().toISOString();

    await store.insertEvent({
      id: newId('evt'),
      tracking_id: link.tracking_id,
      type: 'CLICK',
      timestamp: ts,
      user_agent: ua,
      ip_hash,
      click_id: clickId,
      destination,
      suspected_self_open: false,
      confidence: 0.5,
    });

    const email = await store.getEmail(link.tracking_id);
    const click_count = (email?.click_count || 0) + 1;
    const patch: Partial<EmailRow> = {
      click_count,
      last_clicked_at: ts,
    };
    if (click_count === 1) patch.first_clicked_at = ts;
    await store.updateEmail(link.tracking_id, patch);
  } catch (e) {
    console.error('click record failed', e);
  }

  return Response.redirect(destination, 302);
}
