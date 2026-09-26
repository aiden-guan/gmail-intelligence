# Chrome Web Store readiness

Status: the package is prepared for submission. It has not been submitted; there is no public listing yet.

## Package

Build with `npm run package`. The ZIP (`release/PigeonBox-vX.Y.Z.zip`) is what gets uploaded. Packaging fails if it finds:

- source maps, `.env*`, `.dev.vars`, `tracker-config.json`, TypeScript sources, tests, `node_modules`,
- credential patterns or literal values of secrets from local env files,
- `<script src>` pointing at a remote URL,
- a CSP allowing `unsafe-eval`, `unsafe-inline`, remote sources or wildcards,
- files referenced by `manifest.json` that are missing,
- a manifest version that differs from `package.json`.

Release builds turn off experimental features (ChatGPT web sign-in) and omit source maps.

## Manifest V3 audit

### Required permissions

| Permission | Why |
|---|---|
| `storage` | Settings, tracked-email list, session state |
| `unlimitedStorage` | IndexedDB index and on-device model weights (≈270–920 MB) in the origin-private file system |
| `notifications` | Open/click and follow-up reminder alerts |
| `alarms` | Tracking poll and reminder schedule |
| `scripting` | Injecting InboxSDK's bundled `pageWorld.js` into Gmail's MAIN world, as InboxSDK requires under MV3 |
| `sidePanel` | Split inbox and Ask Inbox panel |
| `offscreen` | Running WebGPU/ONNX and Gemini Nano outside the service worker (reason `WORKERS`) |
| host `https://mail.google.com/*` | The product works inside Gmail |

Removed in 0.2.0: `tabs`, `activeTab`, and required hosts `chatgpt.com`, `*.convex.site`, `127.0.0.1:8787`, `localhost:8787`.

### Optional permissions (requested at the moment of use)

| Permission | When |
|---|---|
| `identity` | Signing in to PigeonBox Cloud (`launchWebAuthFlow`) |
| `https://*/*` | The user connects a specific HTTPS origin: their BYOK endpoint, their tracker, Hugging Face for model downloads, or PigeonBox Cloud. Each request names the exact origin. |
| `http://127.0.0.1/*`, `http://localhost/*` (and `:8787`, `:11434`) | Ollama, a local tracker, or local Cloud development |

`https://*/*` is declared as optional because BYOK endpoints and self-hosted trackers are user-chosen. Reviewers may ask about it; the answer is that only the origin the user types is ever requested.

### Remote code

All JavaScript and WebAssembly ship in the package: the app bundles, InboxSDK's `pageWorld.js` and `background.js` (vendored from `@inboxsdk/core`), and ONNX Runtime's `ort-wasm-simd-threaded.asyncify.{wasm,mjs}`. CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. `wasm-unsafe-eval` is needed to compile the bundled WASM.

Model weights for on-device AI are downloaded from Hugging Face on user request. They are data (ONNX graphs and tensors) executed by the bundled runtime, not code. They are not bundled because of their size (up to ~900 MB each).

InboxSDK: the bundled InboxSDK contains a Google API key that is InboxSDK's own public browser key. The package check allowlists exactly the keys present in `@inboxsdk/core`.

### Experimental ChatGPT web session

Excluded from release builds (`VITE_PIGEONBOX_EXPERIMENTAL=false`): the UI is hidden, the background refuses `CHATGPT_LOGIN`, its tab listeners are not installed, and `chatgpt.com` is no longer a host permission. The code remains in the bundle but is inert. It must not be enabled in a store build.

## Listing checklist (manual)

- [x] 128×128 icon (generated from the mascot; earlier builds shipped 16×16 placeholders)
- [ ] Developer account and verified publisher email
- [ ] Single purpose: "Inbox intelligence and open tracking for Gmail"
- [ ] Permission justifications (table above)
- [ ] Privacy policy URL (Cloud web `/privacy`, or a page in this repository for Local-only)
- [ ] Data-use disclosures: website content (email) processed; in Local mode not transmitted except to user-chosen providers; in Cloud mode transmitted to PigeonBox for processing, not sold, not used for unrelated purposes
- [ ] Screenshots (1280×800) from a real Gmail session with test mail; the design preview in `docs/design/` uses fictional mail and is not a store screenshot
- [ ] 440×280 promo tile
- [ ] Store description consistent with README; no claims of features that do not exist
- [ ] Test the uploaded ZIP on a clean Chrome profile before publishing

## After listing

Add the store link to README's Install table and the Chrome Web Store badge. Do not add a badge before the listing exists.
