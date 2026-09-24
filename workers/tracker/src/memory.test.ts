import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function browserHeaders(extra?: Record<string, string>): HeadersInit {
  return {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...extra,
  };
}

function proxyHeaders(): HeadersInit {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy',
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

    const pixel = await worker.fetch(new Request(body.pixel_url, { headers: browserHeaders() }), env);
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

  it('Case A — pre-send fetch: OPEN before sentAt does not count', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case A', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    // 1. Pixel opens while status is still PENDING
    await worker.fetch(new Request(pixel_url), env);

    const emailPending = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number; status: string };
    expect(emailPending.status).toBe('PENDING');
    expect(emailPending.open_count).toBe(0);

    // 2. Event inserted before sentAt timestamp
    const futureSent = new Date(Date.now() + 60_000).toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: futureSent }),
      }),
      env,
    );

    // Fetch pixel when now < sentAt
    await worker.fetch(new Request(pixel_url), env);
    const emailFuture = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailFuture.open_count).toBe(0);
  });

  it('Case B — legitimate fast recipient: sentAt = T, OPEN = T + 1 second, no SELF_VIEW -> recipient open count = 1', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case B', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    // sentAt = 1 second ago
    const sentAt = new Date(Date.now() - 1000).toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: sentAt }),
      }),
      env,
    );

    // Recipient opens fast (1 second after send), no SELF_VIEW
    await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(email.open_count).toBe(1);

    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ classification: string }>;
    expect(events[0]?.classification).toBe('RECIPIENT_LIKELY');
  });

  it('Case C — sender views own message: SELF_VIEW = T + 30 seconds, OPEN = SELF_VIEW + small delta -> classified SELF_LIKELY -> recipient open count remains 0', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case C', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    // Sent 30 seconds ago
    const sentAt = new Date(Date.now() - 30_000).toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: sentAt }),
      }),
      env,
    );

    // Sender views own message: SELF_VIEW reported
    const selfViewTime = new Date().toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ timestamp: selfViewTime }),
      }),
      env,
    );

    // Pixel loads right after (small delta)
    await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(email.open_count).toBe(0);

    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; classification: string }>;
    const openEvt = events.find((e) => e.type === 'OPEN');
    expect(openEvt?.classification).toBe('SELF_LIKELY');
  });

  it('Case D — race: OPEN arrives, SELF_VIEW arrives shortly afterward -> reclassification occurs -> final aggregate recipient open count = 0', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case D', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: new Date(Date.now() - 10_000).toISOString() }),
      }),
      env,
    );

    // Pixel fetched before self-view
    await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
    const emailBefore = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailBefore.open_count).toBe(1);

    // Self-view arrives shortly afterward (within correlation window)
    const selfViewRes = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ timestamp: new Date().toISOString() }),
      }),
      env,
    );
    expect(selfViewRes.status).toBe(200);

    const emailAfter = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailAfter.open_count).toBe(0);
  });

  it('Case E — sender view after recipient open: recipient OPEN -> count = 1, later SELF_VIEW + own pixel fetch -> count remains 1', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case E', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: new Date(Date.now() - 120_000).toISOString() }),
      }),
      env,
    );

    // Recipient opens email
    const openRes = await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
    expect(openRes.status).toBe(200);

    const emailAfterRecipient = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailAfterRecipient.open_count).toBe(1);

    // Later (>15s after recipient open), sender views own message
    const laterSelfViewTime = new Date(Date.now() + 30_000).toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ timestamp: laterSelfViewTime }),
      }),
      env,
    );

    const emailAfterSelfView = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailAfterSelfView.open_count).toBe(1);
  });

  it('Case F — repeated sender opens: Multiple sender self-views must not inflate recipient count', async () => {
    vi.useFakeTimers();
    try {
      const baseTime = Date.parse('2026-09-24T10:00:00.000Z');
      vi.setSystemTime(baseTime);

      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ subject: 'Case F', sender: 'me@example.com', recipients: ['r@example.com'] }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime - 60_000).toISOString() }),
        }),
        env,
      );

      // Sender views repeatedly (3 times) with advancing time
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(20_000);
        const now = new Date().toISOString();
        await worker.fetch(
          new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ timestamp: now }),
          }),
          env,
        );
        await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
      }

      const email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      // None of the sender self-views should inflate recipient open count
      expect(email.open_count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatic Google-image-proxy fetch stores PROXY_LIKELY and does not turn open_count to 1', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Proxy Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: new Date(Date.now() - 1000).toISOString() }),
      }),
      env,
    );

    // Pixel request with GoogleImageProxy UA
    const pixelRes = await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
    expect(pixelRes.status).toBe(200);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(email.open_count).toBe(0);

    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; classification: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].classification).toBe('PROXY_LIKELY');
  });

  it('scanner fetch stores MACHINE_LIKELY and does not increment open_count', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Scanner Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: new Date(Date.now() - 1000).toISOString() }),
      }),
      env,
    );

    // Pixel request with scanner UA
    const pixelRes = await worker.fetch(
      new Request(pixel_url, { headers: { 'User-Agent': 'Barracuda Sentinel Scanner/1.0' } }),
      env,
    );
    expect(pixelRes.status).toBe(200);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(email.open_count).toBe(0);

    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; classification: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].classification).toBe('MACHINE_LIKELY');
  });

  it('Self-view reported with gmailThreadId links to email', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Link Thread', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id } = (await created.json()) as { tracking_id: string };

    const selfViewRes = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ timestamp: new Date().toISOString(), gmailThreadId: 'thread-xyz' }),
      }),
      env,
    );
    expect(selfViewRes.status).toBe(200);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { gmail_thread_id: string };
    expect(email.gmail_thread_id).toBe('thread-xyz');
  });

  it('MV3 background delay: self-view arriving 5s after pixel fetch reclassifies preceding open and resets open_count to 0', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ subject: 'MV3 Delay Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      // Mark sent
      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // Sender views email at T+10s in content script
      vi.advanceTimersByTime(10_000);
      const observedAtIso = new Date().toISOString();

      // Browser requests tracking pixel at T+10.5s (before MV3 background wakes up)
      vi.advanceTimersByTime(500);
      const pixelRes = await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
      expect(pixelRes.status).toBe(200);

      // Pixel open is temporarily classified as recipient open before self-view arrives
      const midEmail = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(midEmail.open_count).toBe(1);

      // MV3 background service worker wakes up 4.5s later (T+15s) and delivers the content interaction timestamp (T+10s)
      vi.advanceTimersByTime(4500);
      const selfViewRes = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ timestamp: observedAtIso }),
        }),
        env,
      );
      expect(selfViewRes.status).toBe(200);
      const selfViewBody = (await selfViewRes.json()) as { ok: boolean; open_count: number };
      expect(selfViewBody.ok).toBe(true);
      expect(selfViewBody.open_count).toBe(0);

      // Verified: Email open_count is reverted to 0
      const finalEmail = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number; first_opened_at: string | null };
      expect(finalEmail.open_count).toBe(0);
      expect(finalEmail.first_opened_at).toBeNull();

      // Event classification was updated to SELF_LIKELY with suspected_self_open: true
      const events = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
      ).json()) as Array<{ type: string; classification: string; suspected_self_open: boolean }>;
      const openEvent = events.find((e) => e.type === 'OPEN');
      expect(openEvent?.classification).toBe('SELF_LIKELY');
      expect(openEvent?.suspected_self_open).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Self-view preserves payload timestamp over server arrival time, and falls back to now when omitted', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Timestamp Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id } = (await created.json()) as { tracking_id: string };

    const customTs = '2026-09-24T08:15:30.000Z';
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ timestamp: customTs }),
      }),
      env,
    );

    let events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; timestamp: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBe(customTs);

    // Now test fallback when timestamp is omitted
    const created2 = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Fallback Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id: tracking_id_2 } = (await created2.json()) as { tracking_id: string };

    const before = Date.now();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id_2}/self-view`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({}),
      }),
      env,
    );
    const after = Date.now();

    events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id_2}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; timestamp: string }>;
    expect(events).toHaveLength(1);
    const fallbackMs = Date.parse(events[0].timestamp);
    expect(fallbackMs).toBeGreaterThanOrEqual(before - 1000);
    expect(fallbackMs).toBeLessThanOrEqual(after + 1000);
  });

  it('Normalizes gmail message and thread IDs with msg-a:, msg-f:, and # prefixes across create, patch, and self-view', async () => {
    // 1. Create with prefixes
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Normalize Test',
          sender: 'me@example.com',
          recipients: ['r@example.com'],
          gmail_message_id: 'msg-a:r-1234567890',
          gmail_thread_id: '#thread-f:189abcdef',
        }),
      }),
      env,
    );
    const { tracking_id } = (await created.json()) as { tracking_id: string };

    let email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { gmail_message_id: string; gmail_thread_id: string };
    expect(email.gmail_message_id).toBe('r-1234567890');
    expect(email.gmail_thread_id).toBe('189abcdef');

    // 2. Patch with prefixes
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({
          gmail_message_id: 'msg-f:r-9999999999',
          gmail_thread_id: 'thread-a:999abcdef',
        }),
      }),
      env,
    );

    email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { gmail_message_id: string; gmail_thread_id: string };
    expect(email.gmail_message_id).toBe('r-9999999999');
    expect(email.gmail_thread_id).toBe('999abcdef');

    // 3. Self-view linking with prefixes on an email without existing ids
    const created2 = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Normalize Self-View Link Test',
          sender: 'me@example.com',
          recipients: ['r@example.com'],
        }),
      }),
      env,
    );
    const { tracking_id: tracking_id_2 } = (await created2.json()) as { tracking_id: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id_2}/self-view`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          gmailMessageId: '#msg-a:linked-msg-456',
          gmailThreadId: 'thread-f:linked-thread-789',
        }),
      }),
      env,
    );

    const email2 = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id_2}`, { headers: authHeaders() }), env)
    ).json()) as { gmail_message_id: string; gmail_thread_id: string };
    expect(email2.gmail_message_id).toBe('linked-msg-456');
    expect(email2.gmail_thread_id).toBe('linked-thread-789');
  });
});
