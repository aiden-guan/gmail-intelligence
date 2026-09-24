# Changelog

All notable changes to Gmail Intelligence are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — 2026-09-24

### Summary
Comprehensive resolution of false "Opened" states and thread matching regressions introduced in commit `74d9604` without destabilizing the outbound request-modifier send architecture, AI drafting, or AI summaries.

### Architectural & Functional Highlights
| Component / Layer | Change | Impact |
| :--- | :--- | :--- |
| **Tracking Lifecycle** (`packages/tracking`) | Added `detectOpenRequestSource()` and authoritative `deriveTrackingStats()` | Filters out Google Image Proxy, scanners, and headless bots from open aggregates while maintaining raw audit logs. |
| **Thread Matching** (`packages/tracking`) | Replaced `preferOpened()` with priority-based message-id and recency matching | Ensures new sends in an existing thread show unread status until genuinely opened. |
| **Sent Status UI** (`apps/extension`) | Stamped tracking datasets on rows and made `paintConversation` a pure render | Eliminates stale closure attribution on recycled rows and prevents excessive self-view emissions. |
| **InboxSDK Integration** (`apps/extension`) | Connected `registerMessageViewHandler` with message-id precision | Accurately correlates self-views with sender opens using an asymmetric `[-3s, +8s]` window. |
| **Tracker Backends** (`workers/tracker`, `convex`) | Synchronized classification rules and aggregate derivations | Eliminates divergent classification and guarantees reliable open counts across Cloudflare Worker and Convex backends. |

### Detailed Changes

#### Added
- **`@gi/tracking`**: Added `OpenRequestSource` detection (`browser_like`, `google_image_proxy`, `scanner`, `headless`, `unknown`).
- **`@gi/tracking`**: Added `deriveTrackingStats()` for authoritative, deduplicated (800ms) open and click count derivation.
- **`@gi/tracking`**: Added `isSelfViewCorrelated(openTs, selfViewTs)` implementing asymmetric `[-3s, +8s]` windowing.
- **`@gi/tracking`**: Added `regression-matrix.test.ts` verifying Cases A through L end-to-end.
- **`@gi/shared`**: Added `gmailMessageId` field support to `TRACKING_SELF_VIEW` runtime message schema.
- **Convex Tracker**: Added comprehensive integration unit tests in `convex/openRequest.test.ts`.

#### Changed / Refactored
- **`@gi/tracking`**: Completely removed `preferOpened()` in `matchTrackedEmail()`, giving precedence to exact `gmailMessageId` and newest send by timestamp.
- **`apps/extension`**: In `paintRows()`, stamped `dataset.giTrackingId`, `giTrackingThreadId`, and `giTrackingMessageId` dynamically on DOM elements to avoid stale closure binding during row recycling.
- **`apps/extension`**: Refactored `pollTracking()` in background service worker to only call `applyRecentOpens()` as fallback when remote query fails (`!sawRemote`).
- **`workers/tracker`**: Synchronized `handleOpen`, `handleSelfView`, and `recomputeEmailStats` to use shared `deriveTrackingStats` rules.

#### Fixed
- **Proxy & Machine False Opens**: Prevented Google Image Proxy (`GoogleImageProxy`, `ggpht`) and automated scanners from incrementing `openCount`.
- **Self-View Over-Triggering**: Removed `onSelfView` from `paintConversation()` to prevent self-view registration on every DOM paint cycle.
- **Window Overlap Bug**: Tightened self-view correlation from broad `±15s` to `[-3s, +8s]`, preventing swallow of legitimate recipient opens.
- **Notification Spam**: Filtered extension desktop notifications strictly to verified `RECIPIENT_LIKELY` events.
- **Worker Test Suite**: Fixed timer synchronization in `workers/tracker/src/memory.test.ts` (`Case F`).
- **Sender Self-Open Race (MV3 Wake-up Delay)**: Fixed sender interaction timestamp distortion caused by Manifest V3 background service worker cold-start delays by capturing interaction-time `observedAt` and delivering it in the `TRACKING_SELF_VIEW` message payload.
- **InboxSDK ID Prefix Mismatches**: Unified `normalizeGmailId()` across extension content scripts, workers, and Convex to strip `msg-a:`, `msg-f:`, `thread-a:`, `thread-f:`, and `#` prefixes.
- **MessageView Expansion Lifecycle**: Built `MessageSelfViewController` to safely track InboxSDK `MessageView` expansion state (`EXPANDED`), subscribe to `viewStateChange` and `load`, and handle late cache arrival races with `reinspectActive()`.

### Verification Proof
- `npm test`: 27 test files passed, 230 tests passed.
- `npm run typecheck`: Passed with 0 TypeScript errors across all workspaces.
- `npm run lint`: Passed with 0 errors across packages, apps, and workers.
- `npm run build`: Production build verified for shared, gmail, mailbox, ai, search, agent, tracking, extension, and tracker packages.

