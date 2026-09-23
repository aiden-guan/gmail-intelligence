# Contributing

Thanks for helping improve Gmail Intelligence.

## Principles

- No Gmail REST API, no private Gmail write RPCs, no cookie scraping.
- Writes go through Gmail’s web UI via `packages/gmail` only.
- Mailbox contents never go to the tracking backend.
- Prefer capability detection and degradation over pretending features work.
- Never auto-send; Tier 3 actions need explicit confirmation.

## Dev setup

Node.js 20 or newer.

```bash
npm run setup
npm test
```

`npm run dev` rebuilds the extension while you edit. Click **Reload** on `chrome://extensions` after each rebuild. `npm run tracker` starts a local open/click tracker with no cloud account.

## Packages

Keep Gmail selectors inside `packages/gmail/src/selectors.ts`. Application code must not know DOM details.

## Pull requests

- Small, focused PRs
- Include/extend Vitest coverage for logic you change
- Do not commit secrets, `.env`, or personal mailbox data

## InboxSDK

Register an App ID at InboxSDK if you use their production features; for local experiment the extension can fall back to DOM adapters.
