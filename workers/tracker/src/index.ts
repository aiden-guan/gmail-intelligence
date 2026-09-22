import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { safeRedirectUrl, suspectSelfOpen } from './helpers.js';

export { safeRedirectUrl, suspectSelfOpen } from './helpers.js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  PERSONAL_API_TOKEN: string;
}

const TRANSPARENT_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0),
);

const CreateEmailSchema = z.object({
  subject: z.string().max(998),
  sender: z.string().max(320),
  recipients: z.array(z.string().max(320)).min(1).max(100),
  gmail_thread_id: z.string().max(128).optional(),
  gmail_message_id: z.string().max(128).optional(),
  links: z.array(z.object({ url: z.string().url() })).max(50).optional(),
});

function db(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Public pixel
      if (request.method === 'GET' && path.startsWith('/open/')) {
        return handleOpen(path.slice('/open/'.length), request, env);
      }
      // Public click
      if (request.method === 'GET' && path.startsWith('/c/')) {
        return handleClick(path.slice('/c/'.length), request, env);
      }

      // Private management
      if (path.startsWith('/api/')) {
        const denied = requireAuth(request, env);
        if (denied) return denied;

        if (request.method === 'POST' && path === '/api/emails') {
          return handleCreateEmail(request, env, url.origin);
        }
        if (request.method === 'GET' && path.startsWith('/api/emails/') && path.endsWith('/events')) {
          const id = path.slice('/api/emails/'.length, -'/events'.length);
          return handleGetEvents(id, env);
        }
        if (request.method === 'GET' && path.startsWith('/api/emails/')) {
          const id = path.slice('/api/emails/'.length);
          return handleGetEmail(id, env);
        }
        if (request.method === 'GET' && path === '/api/events/recent') {
          return handleRecentEvents(env);
        }
      }

      if (path === '/health') {
        return json({ ok: true });
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal' }, 500);
    }
  },
};

async function handleCreateEmail(request: Request, env: Env, origin: string): Promise<Response> {
  const body = CreateEmailSchema.parse(await request.json());
  const tracking_id = newId('trk');
  const supabase = db(env);
  const sent_at = new Date().toISOString();

  const { error } = await supabase.from('tracked_emails').insert({
    tracking_id,
    subject: body.subject,
    sender: body.sender,
    recipients: body.recipients,
    gmail_thread_id: body.gmail_thread_id ?? null,
    gmail_message_id: body.gmail_message_id ?? null,
    sent_at,
    open_count: 0,
    click_count: 0,
  });
  if (error) return json({ error: error.message }, 500);

  const rewritten_links: Array<{ click_id: string; original: string; tracked_url: string }> = [];
  for (const link of body.links || []) {
    const safe = safeRedirectUrl(link.url);
    if (!safe) continue;
    const click_id = newId('clk');
    await supabase.from('tracked_links').insert({
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
    rewritten_links,
  });
}

async function handleGetEmail(id: string, env: Env): Promise<Response> {
  if (!id || id.length > 80) return json({ error: 'bad_id' }, 400);
  const supabase = db(env);
  const { data, error } = await supabase
    .from('tracked_emails')
    .select('*')
    .eq('tracking_id', id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: 'not_found' }, 404);
  return json(data);
}

async function handleGetEvents(id: string, env: Env): Promise<Response> {
  if (!id || id.length > 80) return json({ error: 'bad_id' }, 400);
  const supabase = db(env);
  const { data, error } = await supabase
    .from('tracking_events')
    .select('*')
    .eq('tracking_id', id)
    .order('timestamp', { ascending: false })
    .limit(200);
  if (error) return json({ error: error.message }, 500);
  return json(data || []);
}

async function handleRecentEvents(env: Env): Promise<Response> {
  const supabase = db(env);
  const { data, error } = await supabase
    .from('tracking_events')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(50);
  if (error) return json({ error: error.message }, 500);
  return json(data || []);
}

async function handleOpen(trackingId: string, request: Request, env: Env): Promise<Response> {
  // Always return GIF immediately path — record best-effort
  if (!trackingId || trackingId.length > 80 || !/^[\w-]+$/.test(trackingId)) {
    return gifResponse();
  }

  try {
    const supabase = db(env);
    const { data: email } = await supabase
      .from('tracked_emails')
      .select('tracking_id, sent_at, open_count')
      .eq('tracking_id', trackingId)
      .maybeSingle();

    if (email) {
      const ua = request.headers.get('User-Agent');
      const ip =
        request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
        '';
      const ip_hash = ip ? await hashIp(ip, env.PERSONAL_API_TOKEN || 'salt') : null;
      const now = Date.now();
      const self = suspectSelfOpen({ sentAt: email.sent_at, now, ua });
      const ts = new Date(now).toISOString();

      await supabase.from('tracking_events').insert({
        id: newId('evt'),
        tracking_id: trackingId,
        type: 'OPEN',
        timestamp: ts,
        user_agent: ua,
        ip_hash,
        suspected_self_open: self.suspected,
        confidence: self.confidence,
      });

      const open_count = (email.open_count || 0) + 1;
      const patch: Record<string, unknown> = {
        open_count,
        last_opened_at: ts,
      };
      if (open_count === 1) {
        patch.first_opened_at = ts;
      }
      await supabase.from('tracked_emails').update(patch).eq('tracking_id', trackingId);
    }
  } catch (e) {
    console.error('open record failed', e);
  }

  return gifResponse();
}

async function handleClick(clickId: string, request: Request, env: Env): Promise<Response> {
  if (!clickId || clickId.length > 80 || !/^[\w-]+$/.test(clickId)) {
    return json({ error: 'bad_id' }, 400);
  }

  const supabase = db(env);
  const { data: link } = await supabase
    .from('tracked_links')
    .select('*')
    .eq('click_id', clickId)
    .maybeSingle();

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

    await supabase.from('tracking_events').insert({
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

    const { data: email } = await supabase
      .from('tracked_emails')
      .select('click_count')
      .eq('tracking_id', link.tracking_id)
      .maybeSingle();

    const click_count = (email?.click_count || 0) + 1;
    const patch: Record<string, unknown> = {
      click_count,
      last_clicked_at: ts,
    };
    if (click_count === 1) {
      patch.first_clicked_at = ts;
    }
    await supabase.from('tracked_emails').update(patch).eq('tracking_id', link.tracking_id);
  } catch (e) {
    console.error('click record failed', e);
  }

  return Response.redirect(destination, 302);
}
