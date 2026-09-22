# Gmail Intelligence

Personal **Gmail** Chrome extension: local AI inbox intelligence + Mailsuite-style open/click tracking.

**No Gmail REST API.** Reads what Gmail already loaded in the browser. Writes (archive, draft, mark read, …) go through Gmail’s normal web UI via a carefully abstracted interaction layer.

## Features

- Category chips & split views (Respond / Waiting / FYI / Notifications / Promotions / News / Follow-ups)
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
  → Gmail Integration Layer (InboxSDK primary, Gmail.js optional capture, DOM fallback)
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

## Setup

```bash
cd /Users/aidenguan/Documents/Projects/EmailApp
cp .env.example .env   # fill tracker/Supabase secrets for worker only
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

Extension build output: `apps/extension/dist`.

## Supabase

1. Create a project.
2. Run `supabase/migrations/20260322000000_tracking.sql` in the SQL editor.
3. Copy project URL + **service role** key (worker only — never in the extension).

## Cloudflare Worker

```bash
cd workers/tracker
npx wrangler login
npx wrangler secret put PERSONAL_API_TOKEN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler deploy
```

Local:

```bash
cd workers/tracker
# set .dev.vars with the same keys
npx wrangler dev --port 8787
```

Routes: `POST /api/emails`, `GET /api/emails/:id`, `GET /api/emails/:id/events`, `GET /api/events/recent` (Bearer token). Public: `GET /open/:trackingId`, `GET /c/:clickId`.

## Load unpacked in Chrome

1. `npm run build`
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked**
3. Select `apps/extension/dist`
4. Open Gmail (`https://mail.google.com`)
5. Extension **Settings** opens on a fresh install. Sign in with ChatGPT, or download a model
6. Optional: set the tracker URL and token, and grant host permission for a custom tracker domain

## AI configuration

Settings → AI:

- **ChatGPT account** — sign in on chatgpt.com with your own account. Requests use that plan’s message allowance. Inbox text is sent as a temporary chat, and the session stays in extension storage. It never goes to the tracker.
- **On this computer** — Qwen2.5 0.5B (about 750 MB) and Qwen3 0.6B (about 880 MB) are listed for download. Nothing is stored until you download one, and Remove deletes those files. Chrome’s built-in Gemini Nano is a larger optional download for desktop Chrome 138+ with about 16 GB of memory and 22 GB of free disk.
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

- InboxSDK (primary UI)
- Gmail.js capture (optional MAIN-world observation)
- DOM fallback (centralized selectors in `packages/gmail/src/selectors.ts`)

Native Gmail label mutation is **not** claimed (`persistentNativeLabelMutationAvailable: false`). Virtual labels always work.

**Live Gmail E2E was not verified in this environment.** Use Settings → Run diagnostics on a real Gmail tab.

## Indexing

- Incremental from visible/loaded mail — no giant scrape on startup
- Fingerprint: `SHA-256(threadId + latestMessageId + latestTimestamp + bodyHash)`
- Unchanged fingerprint → skip re-summarize / re-classify / re-embed / re-draft
- Ask Inbox states coverage explicitly (never pretends to search unindexed mail)

## Limitations

- DOM/InboxSDK breakage when Gmail updates
- Background automation needs Gmail/browser open; worker tab is optional reuse
- Local index may be incomplete
- Open tracking is imperfect (Apple Mail Privacy, image blocking, proxies) — UI says “Open detected”, not “Definitely read”
- Group sends / list-id edge cases
- AI can be wrong; rules override AI
- **No automatic sending**; Tier 3 (send/delete/spam/unsubscribe/large destructive batches) always needs explicit user action

## First end-to-end test (manual)

1. Deploy tracker + migration; put URL + token in Settings.
2. Compose in Gmail with tracking on → send via Gmail → open pixel URL (or the email) → confirm event in Worker/Supabase and optional Chrome notification (“Open detected”).
3. Enable AI (or rely on heuristics) → open an inbox thread → confirm category chip / sidebar summary.
4. Side panel → Ask Inbox “what needs a response?” → confirm citations + coverage note.
5. Settings → Index recent 7d (with Gmail open) → confirm coverage counts increase.

## License

MIT — see `LICENSE`.
