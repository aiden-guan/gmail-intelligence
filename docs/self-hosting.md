# Self-hosting

PigeonBox Local runs entirely in your browser. The only server component you might want is an **open/click tracker**, because a tracking pixel must be fetched from a public URL. All of this is optional.

| Option | Persistence | Accounts needed | Guide |
|---|---|---|---|
| `npm run tracker` on this computer | Memory (lost on stop); only reachable from this machine | None | [local-setup.md](local-setup.md) |
| Cloudflare Worker + Supabase | Postgres | Cloudflare, Supabase | Below |
| Cloudflare Worker, no Supabase | Memory per Worker isolate (not durable) | Cloudflare | Testing only |
| Convex | Convex database | Convex | [convex-self-hosting.md](convex-self-hosting.md) |

A tracker on `127.0.0.1` only records opens from your own machine. To see real recipient opens, deploy a public tracker.

Every self-hosted tracker is **single-owner**: one `PERSONAL_API_TOKEN` protects its management API. Pixel (`/open/:id`) and click (`/c/:id`) routes are public by design. Tracking IDs are random and carry no mailbox data.

## Cloudflare Worker + Supabase

### 1. Supabase

Create a project and apply the migrations in `supabase/migrations/` in order (SQL editor or `supabase db push`). They create `tracked_emails`, `tracked_links`, `tracking_events` and `tracking_self_view_claims` with RLS enabled and no client policies; only the Worker's service role reads or writes them.

### 2. Worker

```bash
cd workers/tracker
npx wrangler login
npx wrangler secret put PERSONAL_API_TOKEN          # the token from your .env
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # stays on the Worker, never in the extension
npx wrangler deploy
```

The Worker name in `wrangler.toml` is `gi-tracker`. It is kept from before the PigeonBox rename because renaming it deploys a different `*.workers.dev` URL, and pixels in mail you already sent point at the old one.

### 3. Connect PigeonBox

Settings → Email tracking → paste the Worker URL and the same token → **Save**. Chrome asks for permission to reach that host. The status line should read **Tracker healthy**.

### Updating

Redeploy after pulling changes to `workers/tracker` and apply new migrations. Settings shows "Tracker deployment is outdated" when the tracker lacks a protocol feature the extension needs.

## What the tracker stores

Per tracked email: subject, sender, recipients, Gmail thread/message IDs, sent time, open/click counts. Per event: time, user agent, a salted hash of the IP (never the raw IP), classification. Link destinations for rewritten links. Mailbox bodies are never sent to the tracker.

## Disconnecting

Clear the URL and token in Settings → Email tracking (or turn tracking off) and save. Delete the Worker and Supabase project to remove stored data.
