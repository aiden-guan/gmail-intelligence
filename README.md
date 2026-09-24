# Gmail Intelligence

Personal **Gmail** Chrome extension: local AI inbox intelligence + Mailsuite-style open/click tracking.

**No Gmail REST API.** Reads what Gmail already loaded in the browser. Writes (archive, draft, mark read, …) go through Gmail’s normal web UI via a carefully abstracted interaction layer.

## Features

- Category chips and a side-panel Split Inbox backed by the local index (Respond / Waiting / FYI / Notifications / Promotions / News / Follow-ups / Priority)
- Deterministic + optional AI classification, summaries, needs-reply, auto-drafts (**never auto-send**)
- Auto-archive with confidence thresholds, always/never lists, short-lived Undo
- Reminders via `chrome.alarms` (no Gmail API)
- Ask Inbox side panel (local index + optional RAG)
- Write with AI in compose
- Optional “Index my inbox” (user-triggered, paced, resumable)
- Open/click tracking via Cloudflare Worker + Supabase (architecturally separate from mailbox AI)

## Architecture (no Gmail API)

```
Gmail web app
  → Gmail Integration Layer (InboxSDK primary, DOM fallback)
  → Mailbox event bus → IndexedDB cache + Action engine (Gmail UI)
  → AI agent engine → Side panel / Ask Inbox

Separately:
Tracked email → pixel/click → Cloudflare Worker → Supabase
```

Mailbox contents are **never** sent to the tracking backend. AI keys stay in extension storage / service worker — never MAIN world.

## Repo map

| Path | Role |
|------|------|
| `apps/extension` | MV3 Chrome extension (Vite + React + Tailwind) |
| `packages/gmail` | Gmail adapters, selectors, action queue, worker tab |
| `packages/mailbox` | Dexie IndexedDB, ingest, index jobs, MailboxSource seam |
| `packages/ai` | Provider abstraction (OpenAI-compatible production + interfaces) |
| `packages/search` | MiniSearch lexical + hybrid retrieval |
| `packages/agent` | Heuristics, rules, agent loop, safety tiers |
| `packages/tracking` | Tracking client (pixel/link helpers) |
| `packages/shared` | Zod schemas, settings, fingerprints |
| `workers/tracker` | Cloudflare Worker |
| `supabase/migrations` | Tracking tables |

## Install

You need [Node.js 20 or newer](https://nodejs.org). npm is included.

```bash
git clone https://github.com/aiden-guan/gmail-intelligence.git
cd gmail-intelligence
npm run setup
```

That installs dependencies, writes a gitignored `.env` and tracker token, and builds the extension to `apps/extension/dist`.

Inbox features do not need a Gmail API key, a Cloudflare account, or a Supabase project.

### Load the extension

```bash
npm run setup -- --open
```

That opens the `dist` folder and your browser’s extensions page. If you use more than one Chrome profile, add a gitignored `.local/chrome.json` so it opens the right one:

```json
{ "profileDirectory": "Profile 1", "gmailAccount": "you@school.edu" }
```

`profileDirectory` is that profile’s folder name (`Default`, `Profile 1`, …). By hand:

1. Chrome, Edge, or Brave → `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select `apps/extension/dist` (the folder that contains `manifest.json`)
4. Pin **Gmail Intelligence**, then open [Gmail](https://mail.google.com) while you are signed in
5. Click the extension icon for status, or open Gmail directly. Category labels still work if you skip AI
6. Open a thread. You should see a category label and a summary sidebar
7. If Gmail looks unchanged, open the extension’s Settings and click **Run diagnostics**

A short onboarding page opens on a fresh install. After you change code, run `npm run dev`, then click **Reload** on `chrome://extensions`.

### Try tracking on this computer

```bash
npm run tracker
```

Leave that process running. In the extension, open **Settings → Tracking**, paste the URL and token from `.local/tracker.txt`, and click **Save settings**. The connection line should say **Tracker healthy**. Compose in Gmail until the control says **Tracking ready**, then send. The pixel is added to Gmail’s outbound request, not to the compose box. Confirm it with **Sent → Show original** and a search for `/open/trk_`. The full check is in [docs/tracking-debug.md](docs/tracking-debug.md). Opening the message elsewhere should then show “Open detected”. Image blockers and Apple Mail Privacy can hide or fake that signal.

Events stay in memory until you stop `npm run tracker`. Mailbox text is never sent to the tracker.

Check it:

```bash
curl -s http://127.0.0.1:8787/health
```

You want `{"ok":true,"store":"memory"}`.

### Use your own Convex tracker (optional)

This project does not host a shared tracker. If you want persistent open/click tracking, deploy the Convex functions to a Convex project that you own. The deployment URL, API token, and any tracking data belong to you; none are committed here.

From the repository root:

```bash
npx convex dev --once
npx convex env set PERSONAL_API_TOKEN 'replace-with-a-long-random-token'
```

`npx convex dev --once` configures your own Convex development deployment and writes the local, gitignored `.env.local` file. Copy that deployment's `CONVEX_SITE_URL` and the same token into **Settings → Tracking**. Rebuild, then reload the unpacked extension. For a production deployment, use `npx convex deploy` against your own Convex project and set the token with `npx convex env set --prod PERSONAL_API_TOKEN 'replace-with-a-long-random-token'`.

### Deploy tracking on Cloudflare (optional)

Use this if you want the tracker on Cloudflare instead of Convex.

**Supabase**

1. Create a project.
2. Run `supabase/migrations/20260322000000_tracking.sql` and `supabase/migrations/20260923000000_tracking_status.sql` in the SQL editor.
3. Copy the project URL and **service role** key into `.env` and `workers/tracker/.dev.vars`. The service role key stays on the worker. Never put it in the extension.

**Cloudflare Worker**

```bash
cd workers/tracker
npx wrangler login
npx wrangler secret put PERSONAL_API_TOKEN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler deploy
```

Put the deployed URL and the same personal token in extension Settings. For a custom domain, grant that host permission when Chrome asks.

Routes: `POST /api/emails`, `GET /api/emails/:id`, `GET /api/emails/:id/events`, `GET /api/events/recent` (Bearer token). Public: `GET /open/:trackingId`, `GET /c/:clickId`.

## AI configuration

Settings → AI:

- **On this computer** — Qwen2.5 0.5B (about 750 MB) and Qwen3 0.6B (about 880 MB) are listed for download. Nothing is stored until you download one, and Remove deletes those files. Chrome’s built-in Gemini Nano is a larger optional download for desktop Chrome 138+ with about 16 GB of memory and 22 GB of free disk.
- **ChatGPT account** — experimental. It reads a chatgpt.com session and can stop working when that site changes. It is not required.
- **Off** — tracking and local heuristics still work
- **API key or Ollama** — optional. Ollama uses `http://127.0.0.1:11434/v1`

Anthropic and Gemini API adapters are typed interfaces; use an OpenAI-compatible endpoint for those.

## Privacy

| Data | Where |
|------|--------|
| Mailbox text, embeddings, drafts, rules | Local IndexedDB only |
| AI prompts (when ChatGPT or an API key is on) | That provider. A downloaded model keeps them on this computer |
| Tracking metadata (subject, recipients, open/click events) | Your Worker + Supabase |
| Raw IP | Never stored (hashed only) |
| Service role / AI keys in content scripts | Never |

## Gmail integration fragility

Gmail’s DOM changes. Adapters use capability detection:

- InboxSDK (primary), loaded before observation starts
- DOM fallback (centralized selectors in `packages/gmail/src/selectors.ts`)

Gmail.js is not part of the running extension. `packages/gmail/src/GmailJsCaptureAdapter.ts` remains only as unused experimental source.

Native Gmail label mutation is **not** claimed (`persistentNativeLabelMutationAvailable: false`). Virtual labels always work.

Live Gmail still has to be checked in a signed-in browser. Use Settings → Advanced → Run diagnostics on a real Gmail tab. The checks below are the manual pass.

## Indexing

- Incremental from visible/loaded mail — no giant scrape on startup
- A visible row is a `ROW_STUB` (thread id, subject, sender, snippet). It does not invent a timestamp.
- Opening a thread upgrades it to `THREAD_COMPLETE` using real message text.
- Unchanged fingerprint → skip re-summarize / re-classify / re-draft
- Ask Inbox states coverage explicitly (never pretends to search unindexed mail)

## Limitations

- DOM/InboxSDK breakage when Gmail updates
- Background automation uses one inactive worker tab. It does not take over the Gmail tab you are reading
- Local index may be incomplete
- Open tracking is imperfect (Apple Mail Privacy, image blocking, proxies) — UI says “Open detected”, not “Definitely read”
- Group sends / list-id edge cases
- AI can be wrong; rules override AI
- **No automatic sending**; Tier 3 (send/delete/spam/unsubscribe/large destructive batches) always needs explicit user action

## First end-to-end test (manual)

1. `npm run setup`, load `apps/extension/dist`, open Gmail.
2. Open a thread → category label and sidebar summary (heuristics work with AI off).
3. Extension icon → **Open Inbox Intelligence**. Respond shows locally classified threads, not a Gmail search.
4. Open a thread that needs a reply → **Draft reply** inserts into Gmail’s composer and does not send.
5. Optional: `npm run tracker`, paste `.local/tracker.txt` into Settings, save, send yourself a tracked message, open it → “Open detected”.

## License

MIT — see `LICENSE`.
