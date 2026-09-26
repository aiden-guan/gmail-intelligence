# Privacy model

PigeonBox reads the Gmail web page you already have open. It does not use the Gmail API, OAuth scopes for your mailbox, or your Google cookies. What happens to email content depends on how you choose to run it.

## Where email content goes

| Configuration | Email content used for AI goes to | Stored by PigeonBox |
|---|---|---|
| **Local, AI off** | Nowhere. On-device rules sort mail. | IndexedDB in your browser |
| **Local, downloaded model** | Nowhere. The model runs on WebGPU in the extension. | IndexedDB; model weights in the browser's private file system |
| **Local, Chrome Gemini Nano** | Nowhere. Chrome runs the model on-device. | IndexedDB |
| **Local, Ollama on this computer** | Your Ollama server on `127.0.0.1` | IndexedDB |
| **Local, your API key (BYOK)** | The provider whose endpoint you entered, under your account and its terms | IndexedDB |
| **Local, ChatGPT web session** (experimental, not in release builds) | chatgpt.com, as temporary chats under your account | IndexedDB |
| **PigeonBox Cloud** | PigeonBox Cloud over TLS, then its configured inference provider | IndexedDB locally. Cloud does not store the email content it processes |

Choosing PigeonBox Cloud requires an explicit agreement in Settings. PigeonBox never switches between these on its own. If Cloud is unavailable, requests fail with a clear message and **nothing is sent to another provider**; on-device rules keep working.

## PigeonBox Cloud processing

Hosted AI works as: extension → authenticated PigeonBox API → temporary inference → response. The API:

- does not persist request or response bodies,
- does not log email content (only operational metadata: operation, model, provider, token counts, latency, status, request ID),
- asks its AI gateway not to log payloads and not to cache mailbox prompts,
- records usage for billing and limits without any email text.

Persistent Cloud features that would store mailbox data (sync, cloud search, memory, attachments) do not exist yet. When they arrive they will be separate, explicitly disclosed opt-ins, not a side effect of using Cloud AI.

## Tracking

Tracking is separate from AI. A tracker (yours, or PigeonBox Cloud's in Cloud mode) stores per tracked email: subject, sender, recipients, Gmail IDs, sent time, and open/click events with user agent, a salted IP hash and a classification. It never receives message bodies. Tracking IDs in pixels and links are random and reveal nothing about the mailbox. See [tracking.md](tracking.md).

## Optional self-hosted Convex

A Convex deployment you connect stores only the tracking data above, in your own Convex project. See [convex-self-hosting.md](convex-self-hosting.md).

## Secrets on your device

- API keys and tracker tokens live in `chrome.storage.local`, restricted to extension pages and the service worker. Gmail's page and PigeonBox's content script cannot read them.
- The PigeonBox Cloud refresh token is stored the same way; the short-lived access token stays in memory and session storage.
- The extension ships no server secrets. Release builds are scanned for credentials before packaging.

## Deleting data

- Settings → Advanced → **Clear local mail index** removes the IndexedDB index.
- Removing the extension deletes all of its local storage and downloaded models.
- Self-hosted tracking data lives in your tracker; delete it there.
- PigeonBox Cloud account data is removed by deleting the account (web account page).
