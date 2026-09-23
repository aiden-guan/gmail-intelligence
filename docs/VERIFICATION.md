# Verification notes

## Automated

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Live Gmail

This environment did not sign in to Gmail, so the flows below are **not** claimed as verified here. After loading `apps/extension/dist`:

1. Open Gmail. Settings → Advanced → Run diagnostics.
   - Gmail tab: connected
   - Active integration: InboxSDK or DOM fallback
   - Last Gmail event has a timestamp and a type such as `VISIBLE_ROWS_CHANGED` or `THREAD_OPENED`
2. Open one thread twice. Diagnostics and the activity log should not show a new classification the second time if the message did not change.
3. Click Respond in the Gmail sidebar or the extension side panel. The list is local threads, not a Gmail search. Opening a row goes to that thread.
4. On a Respond thread, click Draft reply. Gmail’s reply box opens with the draft. The extension does not send it.
5. With two Gmail tabs open, turn on auto-archive only if you intend to test it. The inactive pinned worker tab should move, not the tab you are reading.
6. Compose with tracking configured. Send should feel immediate. If the tracker is slow, the message still sends. A sent row shows ✓ until an open is detected, then ✓✓.

## Honest degradation

- Native Gmail label mutation is not available. Categories are local.
- Ask Inbox and summaries use full message text only after a thread has been opened. Row snippets are previews.
- Archive is confirmed by Gmail’s notice, leaving the thread, or the thread disappearing from the inbox list. A click alone is not success.
- ChatGPT web sign-in is experimental and not part of setup.
- Tracking cannot delay or block Send. A miss is logged and the mail goes out untracked.
- Future IMAP throws if selected. Gmail web is the only source.

## Tracker worker

```bash
npm run setup
npm run tracker
curl -s http://127.0.0.1:8787/health
```

Expect `{"ok":true,"store":"memory"}`. The Bearer token is `PERSONAL_API_TOKEN` in `workers/tracker/.dev.vars`.
