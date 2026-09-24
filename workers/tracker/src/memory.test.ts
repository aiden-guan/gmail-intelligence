import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from './index';
import { resetMemoryStore } from './store';

const env: Env = {
  PERSONAL_API_TOKEN: 'test-token',
};

function authHeaders(): HeadersInit {
  return {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  };
}

beforeEach(() => {
  resetMemoryStore();
});

describe('local memory tracker', () => {
  it('reports memory mode on /health without Supabase', async () => {
    const res = await worker.fetch(new Request('http://127.0.0.1:8787/health'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, store: 'memory' });
  });

  it('rejects management calls without the token', async () => {
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/events/recent'),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('records an open and a click redirect', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Hello',
          sender: 'me@example.com',
          recipients: ['you@example.com'],
          links: [{ url: 'https://example.com/docs' }],
        }),
      }),
      env,
    );
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      tracking_id: string;
      pixel_url: string;
      rewritten_links: Array<{ tracked_url: string }>;
    };
    expect(body.pixel_url).toBe(`http://127.0.0.1:8787/open/${body.tracking_id}`);
    expect(body.rewritten_links).toHaveLength(1);

    const pendingPixel = await worker.fetch(new Request(body.pixel_url), env);
    expect(pendingPixel.status).toBe(200);
    expect(pendingPixel.headers.get('Content-Type')).toContain('image/gif');
    const pending = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${body.tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number; status: string; sent_at: string | null };
    expect(pending.status).toBe('PENDING');
    expect(pending.sent_at).toBeNull();
    expect(pending.open_count).toBe(0);

    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const marked = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${body.tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: sentAt }),
      }),
      env,
    );
    expect(marked.status).toBe(200);

    const pixel = await worker.fetch(new Request(body.pixel_url), env);
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get('Content-Type')).toContain('image/gif');

    const email = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${body.tracking_id}`, {
        headers: authHeaders(),
      }),
      env,
    );
    expect(email.status).toBe(200);
    expect(((await email.json()) as { open_count: number }).open_count).toBe(1);

    const click = await worker.fetch(new Request(body.rewritten_links[0].tracked_url), env);
    expect(click.status).toBe(302);
    expect(click.headers.get('Location')).toBe('https://example.com/docs');

    const recent = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/events/recent', { headers: authHeaders() }),
      env,
    );
    const events = (await recent.json()) as Array<{ type: string; classification?: string }>;
    expect(events.filter((event) => event.type === 'CLICK')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'OPEN')).toHaveLength(2);
    expect(events.some((event) => event.classification === 'SELF_LIKELY')).toBe(true);
    expect(events.some((event) => event.classification === 'RECIPIENT_LIKELY')).toBe(true);
  });

  it('lists tracked mail and links a gmail thread without changing opens', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Invoice',
          sender: 'me@example.com',
          recipients: ['you@example.com'],
        }),
      }),
      env,
    );
    const { tracking_id } = (await created.json()) as { tracking_id: string };

    const patched = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ gmail_thread_id: 'thread-1', open_count: 9 }),
      }),
      env,
    );
    expect(patched.status).toBe(400);

    const linked = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ gmail_thread_id: 'thread-1', gmail_message_id: 'msg-1' }),
      }),
      env,
    );
    expect(linked.status).toBe(200);
    const row = (await linked.json()) as { gmail_thread_id: string; open_count: number };
    expect(row.gmail_thread_id).toBe('thread-1');
    expect(row.open_count).toBe(0);

    const list = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails?limit=10', { headers: authHeaders() }),
      env,
    );
    expect(list.status).toBe(200);
    const emails = (await list.json()) as Array<{ tracking_id: string }>;
    expect(emails.map((email) => email.tracking_id)).toContain(tracking_id);
  });
});
