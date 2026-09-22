# Verification notes

## Automated (run in CI / local)

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Not verified in agent environment

- Loading the unpacked extension against live Gmail
- InboxSDK against a real Gmail session
- Gmail.js MAIN-world capture against live XHR interception
- Full worker-tab archive/draft verification on real Gmail
- End-to-end pixel open from a real sent message through notifications
- InboxSDK `presending` cancel → inject → re-send path on live compose

Use Settings → Run diagnostics after Load Unpacked on a Gmail tab.

## Honest degradation

- Native Gmail label mutation is **not** available (`persistentNativeLabelMutationAvailable: false`); virtual labels only.
- Index job reads **visible** Gmail search results via the DOM (scroll-paged); it is not a full-mailbox dump and coverage warnings are intentional.
- Archive undo is best-effort (navigate All Mail + open thread); Gmail may still require a manual Move to Inbox.
- Anthropic / Gemini provider entries are interfaces only — use OpenAI, OpenAI-compatible, or Ollama.
- Future IMAP (`FutureImapSource`) throws if selected; Gmail web is the only V1 source.

## Tracker worker

With secrets configured:

```bash
cd workers/tracker && npx wrangler dev --port 8787
curl -s http://127.0.0.1:8787/health
curl -s -X POST http://127.0.0.1:8787/api/emails \
  -H "Authorization: Bearer $PERSONAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subject":"t","sender":"a@b.com","recipients":["c@d.com"]}'
```
