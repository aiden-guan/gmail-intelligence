<p align="center">
  <img src="apps/extension/public/icons/icon128.png" width="96" height="96" alt="PigeonBox pigeon mascot">
</p>

<h1 align="center">PigeonBox</h1>

<p align="center"><strong>AI-powered Gmail intelligence that can run on your machine.</strong></p>

<p align="center">
  <a href="https://github.com/aiden-guan/pigeonbox/actions/workflows/ci.yml"><img src="https://github.com/aiden-guan/pigeonbox/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

PigeonBox is a Chrome extension that sorts your Gmail inbox, summarizes threads, drafts replies in your voice, answers questions about your mail, and tells you when a sent email is opened. By default everything runs on your computer: a downloaded model on WebGPU, Chrome's built-in Gemini Nano, Ollama, or your own API key. No account, no server, no Gmail API.

<p align="center">
  <img src="docs/design/copper-perch-preview.png" alt="PigeonBox toolbar popup, Respond view in the side panel, and the thread companion card (fictional mail)">
</p>

## Install

| Path | For | Status |
|---|---|---|
| **Chrome Web Store** | Most people. One click, automatic updates. | Listing in preparation ([checklist](docs/chrome-web-store.md)) |
| **GitHub Releases** | A prebuilt, checksummed ZIP to load unpacked. | [Releases](https://github.com/aiden-guan/pigeonbox/releases) |
| **From source** | Contributors and self-hosters. | See [Quick start](#quick-start) |

Loading a ZIP from Releases: unzip it, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder. Unpacked extensions do not update themselves; the Chrome Web Store version will.

## Local and Cloud

One extension, two ways to run it. You choose in **Settings → How should PigeonBox run?**

| | **On this computer** (Local) | **PigeonBox Cloud** |
|---|---|---|
| Account | None | PigeonBox account |
| Cost | Free, open source (MIT) | Subscription |
| AI | Downloaded model (WebGPU), Gemini Nano, Ollama, or your API key | Hosted inference, no downloads or keys |
| Where email content goes for AI | Stays on this device, or goes to the provider you configured | PigeonBox Cloud and its inference provider; processed, not stored |
| Inbox index, search, Ask Inbox | This device (IndexedDB) | This device (IndexedDB) |
| Open/click tracking | Optional, self-hosted (local, Cloudflare Worker, or Convex) | Hosted |
| Works offline / if Cloud is down | Yes | No; switch to Local any time |

Local is a complete product, not a trial. Cloud sells convenience: no model downloads, no API key setup, hosted tracking, and future features that need a server (sync, memory, attachments, automations). Cloud never falls back to another provider when it is unavailable, and PigeonBox never changes your choice for you.

## Features

- **Split inbox**: Respond, Waiting, FYI, Notifications, Promotions, News, Priority, Follow-ups. Rules and on-device heuristics work with AI off.
- **Thread intelligence**: summaries, key dates, action items, open questions.
- **Draft replies and Write with AI**: in your voice and signed with your name. Drafts are inserted into Gmail's composer; **PigeonBox never sends email for you**.
- **Ask Inbox**: questions over your local index, with citations, and an honest note about what has not been indexed.
- **Reminders and follow-ups** via `chrome.alarms`.
- **Open and click tracking** (optional), with sender self-open suppression, Gmail image-proxy handling, and reload detection.
- **Custom rules** in plain language.

## Privacy

| Data | Where it lives |
|---|---|
| Mailbox text, index, embeddings, drafts, rules | IndexedDB in your browser |
| AI prompts, Local mode | This device (downloaded model, Gemini Nano, local Ollama) or the provider whose key you entered |
| AI prompts, Cloud mode | Sent over TLS to PigeonBox Cloud for processing; raw content is not stored or logged |
| Tracking metadata (subject, recipients, open/click events) | Your self-hosted tracker, or PigeonBox Cloud in Cloud mode. Never mailbox bodies |
| API keys, tracker tokens, Cloud sessions | Extension service worker and trusted extension storage. Never Gmail's page or content scripts |

Details: [docs/privacy-model.md](docs/privacy-model.md) and [docs/threat-model.md](docs/threat-model.md).

## Quick start

Requires [Node.js 20+](https://nodejs.org).

```bash
git clone https://github.com/aiden-guan/pigeonbox.git
cd pigeonbox
npm run setup -- --open
```

`setup` checks your Node version, installs dependencies, creates a gitignored `.env` with a generated tracker token, builds the extension, verifies the manifest, and opens `chrome://extensions` plus the build folder. Load `apps/extension/dist` unpacked, open Gmail, and pick how PigeonBox runs in Settings.

No account, Cloud backend, Supabase, Stripe, Convex, Cloudflare account, or AI key is needed. More: [docs/local-setup.md](docs/local-setup.md).

## Develop

```bash
npm run dev       # rebuild on change; click Reload on chrome://extensions
npm test          # Vitest
npm run verify    # everything CI runs: checks, typecheck, lint, tests, build, release ZIP validation
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Self-hosting

- **Tracker on this computer**: `npm run tracker` (in-memory).
- **Tracker on Cloudflare + Supabase**: [docs/self-hosting.md](docs/self-hosting.md).
- **Tracker on your own Convex deployment** (optional): [docs/convex-self-hosting.md](docs/convex-self-hosting.md). Convex is never required; PigeonBox works without it.

## Architecture

```
Gmail web app
  └─ packages/gmail      InboxSDK first, DOM fallback, selectors in one file
       └─ apps/extension content script ──typed messages──▶ background service worker
                                                          ├─ packages/mailbox   IndexedDB index
                                                          ├─ packages/search    lexical + hybrid retrieval
                                                          ├─ packages/agent     rules, safety tiers, jobs
                                                          ├─ packages/ai        AIProvider: WebGPU, Gemini Nano, Ollama, BYOK
                                                          ├─ packages/cloud-client ──HTTPS──▶ PigeonBox Cloud (optional)
                                                          └─ packages/tracking  ──HTTPS──▶ your tracker or Cloud tracker
```

| Path | Role |
|---|---|
| `apps/extension` | The one MV3 extension (Vite, React, Tailwind) |
| `packages/gmail` | Gmail adapters, selectors, action queue, worker tab |
| `packages/mailbox` | Dexie/IndexedDB index and ingestion |
| `packages/ai` | `AIProvider` interface, prompts, local model catalog, BYOK/Ollama |
| `packages/search` | MiniSearch lexical and hybrid retrieval |
| `packages/agent` | Classification, rules, agent loop, safety tiers |
| `packages/tracking` | Tracking client and protocol-v3 open/click classification |
| `packages/shared` | Schemas, settings and migrations, fingerprints |
| `packages/core` | Run mode and capabilities |
| `packages/api-contract` | The typed PigeonBox Cloud protocol (Zod) |
| `packages/cloud-client` | Cloud HTTP client and Cloud `AIProvider` |
| `workers/tracker` | Self-hostable Cloudflare Worker tracker |
| `convex/` | Optional self-hosted Convex tracker |
| `supabase/migrations` | Schema for the self-hosted Worker tracker |

Full write-up: [docs/architecture.md](docs/architecture.md). Cloud protocol: [docs/cloud-protocol.md](docs/cloud-protocol.md).

## Limitations

- Gmail changes its page. Adapters degrade to DOM fallback and diagnostics say what broke; some updates will still need a fix.
- PigeonBox only knows mail you have loaded or chosen to index. Ask Inbox says so when coverage is partial.
- Open tracking is a signal, not proof. Image blocking and Apple Mail Privacy Protection hide or fake opens. PigeonBox says "Open detected", never "read".
- Small on-device models write shorter, plainer drafts than large hosted models.
- Native Gmail labels are not changed; categories are PigeonBox's own.
- AI can be wrong. Your rules override it, and destructive actions always need you.

## Security

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
