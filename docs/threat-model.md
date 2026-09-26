# Threat model

## Assets

1. Email content in the Gmail page and the local IndexedDB index.
2. Credentials: BYOK API keys, tracker personal tokens, PigeonBox Cloud refresh/access tokens.
3. The ability to act in Gmail (draft, archive) as the user.
4. Tracking records (recipients, subjects, open events).
5. For Cloud: other users' data (tenant isolation), billing state, provider keys.

## Trust boundaries

| Boundary | Control |
|---|---|
| Gmail page (untrusted JS, possibly hostile email HTML) ↔ content script | Content script runs in the isolated world. MAIN world is empty; InboxSDK injects only its own vendored `pageWorld.js`. Email HTML is converted to text before rendering in React UI. |
| Content script ↔ service worker | `senderMaySend` allowlists the message types a Gmail content script may send; settings, sign-in, run mode, index clearing, Gmail actions and downloads require an extension page. Content scripts receive only public settings. |
| Extension storage ↔ content script | `chrome.storage.local`/`.session` are `TRUSTED_CONTEXTS`. |
| Service worker ↔ AI providers | Only the provider the user selected. Host permissions for providers are optional and requested per origin. Cloud mode never falls back. |
| Service worker ↔ tracker | Tracker token/Cloud token stay in the worker. Tracker hosts are optional permissions. |
| Service worker ↔ PigeonBox Cloud | TLS; protocol version header; Zod validation both ways; tokens bound to the issuing origin; PKCE with state check. |
| Cloud API ↔ database | Service role on the server only; every query scoped by the user ID from the verified token; RLS as defense in depth. |
| Stripe ↔ Cloud API | Webhook signature verification, timestamp tolerance, event-ID idempotency. |

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| A hostile email or Gmail script reads secrets | Secrets never enter the page or content script; storage restricted to trusted contexts. |
| A compromised content script changes settings or exfiltrates via Cloud | Privileged messages refused from content scripts; content scripts cannot start sign-in or change mode. |
| Extension-origin spoofing | `sender.id` and origin checked; no `externally_connectable`. |
| Remote code | All JS/WASM ships in the package; CSP `script-src 'self' 'wasm-unsafe-eval'`; package validation rejects remote scripts. Model weights are data. |
| Secrets bundled by the build | Only `VITE_*` variables reach the bundle; release packaging scans for credential patterns and for literal values from local env files and refuses to package. `tracker-config.json` and source maps are excluded. |
| Token sent to the wrong server | Cloud session bound to API origin; `normalizeBaseUrl` rejects non-HTTPS (except loopback) and credentials in URLs. |
| Sign-in CSRF / code injection | PKCE S256 + random `state` checked on return; redirect URIs allowlisted server-side. |
| Open redirect via click tracking | Only `http:`/`https:` destinations stored at creation; stored destination re-validated before redirect. |
| Timing attack on tracker token | Constant-time comparison in Worker and Convex. |
| IDOR on tracked emails (Cloud) | Management store scoped to the authenticated user; tracking IDs are random. |
| Client-side entitlement bypass | Entitlements computed server-side from Stripe-synced state; every paid route re-checks. |
| Webhook replay / forgery | Stripe signature + 5-minute tolerance + stored event IDs. |
| Raw email in logs | Cloud logs only metadata; AI gateway payload logging off; no request body logging. |
| Automatic sending | No code path sends mail. Tier 3 actions (send, delete, spam, unsubscribe) always need the user. |
| SSRF (Cloud) | The API calls only configured provider, Supabase and Stripe URLs; no user-supplied URLs are fetched. |

## Known limitations

- A tracker personal token pasted into the extension is readable by anyone with access to the browser profile. It only protects the user's own tracker.
- The experimental ChatGPT web-session provider depends on unofficial endpoints. It is excluded from release builds.
- Open tracking can be spoofed or blocked; it is a signal, not proof.
- Tracking classification logic exists in three implementations (client, Worker, Convex) that must be kept in step by tests.
