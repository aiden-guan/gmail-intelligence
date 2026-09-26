# Local setup

PigeonBox Local needs only Node.js 20+ and Chrome (or Edge/Brave) 116+. It does **not** need a PigeonBox account, PigeonBox Cloud, Supabase, Stripe, Convex, a Cloudflare account, Docker, or an AI key.

## First run

```bash
git clone https://github.com/aiden-guan/pigeonbox.git
cd pigeonbox
npm run setup -- --open
```

`setup`:

1. checks your Node.js version,
2. runs `npm ci` if dependencies are missing,
3. creates a gitignored `.env` from `.env.example` with a generated tracker token, and `workers/tracker/.dev.vars`,
4. writes `.local/tracker.txt` (tracker URL and token to paste into Settings),
5. builds everything and checks the built `manifest.json`,
6. with `--open`, opens the build folder and `chrome://extensions`.

If you use several Chrome profiles, create a gitignored `.local/chrome.json` so `--open` uses the right one:

```json
{ "profileDirectory": "Profile 1", "gmailAccount": "you@example.com" }
```

## Load the extension

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → `apps/extension/dist` (the folder with `manifest.json`).
3. Pin **PigeonBox** and open Gmail.
4. The onboarding page asks how PigeonBox should run. Choose **On this computer**.

## Choose AI (Local)

Settings → **AI on this computer → Change AI**:

- **Downloaded model**: LFM2 700M/1.2B, Gemma 3 1B, Qwen3 0.6B, Qwen2.5 0.5B, SmolLM2 360M. Runs on WebGPU in an offscreen document. Weights (≈270–920 MB) download from Hugging Face only when you click Download and are stored in the browser's origin-private file system. **Remove** deletes them.
- **Chrome Gemini Nano**: Chrome 138+ desktop with enough memory and disk; Chrome manages the download.
- **API key or Ollama**: OpenAI, any OpenAI-compatible endpoint, or Ollama at `http://127.0.0.1:11434/v1`. Chrome asks for permission to reach that host when you connect.
- **Off**: categories still work with on-device rules.

Email content only leaves the device if you choose a remote provider.

## Develop

```bash
npm run dev          # rebuilds apps/extension/dist on change; click Reload on chrome://extensions
npm test             # Vitest (jsdom + fake-indexeddb)
npm run typecheck
npm run lint
npm run verify       # everything CI runs, including the release ZIP check
```

`npm run dev` never starts Convex, a tracker, or any Cloud service.

## Optional: tracking on this computer

```bash
npm run tracker
```

Paste the URL and token from `.local/tracker.txt` into **Settings → Email tracking**, then **Save** (Chrome asks to allow `127.0.0.1:8787`). Events are kept in memory until you stop the tracker. See [tracking.md](tracking.md) and [tracking-debug.md](tracking-debug.md).

## Optional: developing against PigeonBox Cloud

Cloud is not needed for anything above. If you have access to the private `pigeonbox-cloud` repository and run it locally with the mock AI provider, set **Settings → Advanced → PigeonBox Cloud API URL** to `http://127.0.0.1:8788`, save, then choose **PigeonBox Cloud** under "How should PigeonBox run?".

## Troubleshooting

- **Gmail looks unchanged**: Settings → Advanced → **Run diagnostics**. Check "Gmail tab", "Active integration" and the last Gmail event.
- **Model download fails**: allow the Hugging Face permission prompt and keep the Settings tab open until it finishes.
- **"Chrome has not allowed PigeonBox to reach this tracker"**: open Settings → Email tracking and click **Save** to grant access.
