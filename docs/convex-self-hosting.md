# Optional: tracking on your own Convex deployment

**Convex is optional.** PigeonBox Local works without it: inbox features never touch Convex, and tracking also works with `npm run tracker` or the Cloudflare Worker. Convex is not part of `npm run dev`, and PigeonBox Cloud does not use it.

## When Convex is useful

You want persistent open/click tracking with a public URL, and you prefer one Convex project over running a Cloudflare Worker plus a Supabase database. The Convex backend in `convex/` implements the same tracker protocol (v3: self-view claims, proxy suppression, click classification) as `workers/tracker`.

## What it stores

The deployment is yours; PigeonBox does not host a shared Convex tracker. Tables (`convex/schema.ts`):

| Table | Contents |
|---|---|
| `trackedEmails` | Tracking ID, subject, sender, recipients, Gmail thread/message IDs, status, sent time, open/click counts |
| `trackedLinks` | Click ID → destination URL for rewritten links |
| `trackingEvents` | OPEN / CLICK / SELF_VIEW events: time, user agent, salted IP hash, classification |
| `selfViewClaims` | Short-lived sender self-view claims used to ignore your own opens |

No mailbox bodies, drafts, summaries, or AI data are stored. Every Convex function is internal; the only entry points are the HTTP actions in `convex/http.ts`: public `/open/:id`, `/c/:id`, `/health`, and `/api/*` routes that require `Authorization: Bearer <PERSONAL_API_TOKEN>`.

## Deploy

From the repository root:

```bash
npx convex dev --once
npx convex env set PERSONAL_API_TOKEN '<a long random token>'
```

`npx convex dev --once` signs you in to Convex, creates or selects a development deployment you own, pushes the functions, and writes `CONVEX_DEPLOYMENT` and `CONVEX_URL` to the gitignored `.env.local`. The same commands are available as `npm run convex:dev -- --once`.

For a production deployment:

```bash
npx convex deploy
npx convex env set --prod PERSONAL_API_TOKEN '<a long random token>'
```

Self-hosting the open-source Convex backend also works; point the Convex CLI at it as described in Convex's self-hosting documentation and use that deployment's HTTP actions URL below.

## Connect PigeonBox

1. Find the deployment's HTTP actions URL (ends in `.convex.site`) in the Convex dashboard, or `CONVEX_SITE_URL` in `.env.local`.
2. PigeonBox Settings → Email tracking → paste that URL and the same token → **Save**. Chrome asks to allow that host.
3. The status line should read **Tracker healthy**. `curl https://<name>.convex.site/health` should return protocol version 3.

## Disconnect

Clear the tracker URL and token in Settings and save. To delete data, clear the tables in the Convex dashboard or delete the deployment.

## Variables

| Where | Name | Purpose |
|---|---|---|
| Convex deployment env | `PERSONAL_API_TOKEN` | Management API token; also salts IP hashes |
| `.env.local` (written by the CLI) | `CONVEX_DEPLOYMENT`, `CONVEX_URL`, `CONVEX_SITE_URL` | CLI state; not used by the extension |

Convex configuration is separate from, and never merged into, PigeonBox Cloud configuration.
