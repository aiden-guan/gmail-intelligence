# Changelog

All notable changes to Gmail Intelligence are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — 2026-09-24

### Summary
Surgical production hardening pass across tracking self-view correlation, click classification, InboxSDK thread lifecycle, AI job cache bypassing and draft targeting, Dexie schema migration, and content script secrets boundary isolation.

### Architectural & Functional Highlights
| Component / Layer | Change | Impact |
| :--- | :--- | :--- |
| **Self-View Deduplication & State** (`apps/extension`) | Added `SelfViewDeduplicator` and per-view active state tracking | Allows strong message-expanded signals to supersede row interaction hints; preserves `expandedAt` across DOM reinspection. |
| **Row Interaction Targeting** (`apps/extension`) | Filtered out non-reading row clicks (checkboxes, stars, quick action buttons, chips) | Eliminates false self-view triggers from triage actions; tags genuine row clicks with source `ROW_INTERACTION`. |
| **Click Classification Engine** (`packages/tracking`, `workers/tracker`, `convex`) | Introduced `ClickClassification` and retroactively reclassifies clicks on self-views | Excludes sender self-clicks and scanner bots from `clickCount`; reclassifies correlated clicks within `[-3s, +8s]`. |
| **InboxSDK Adapter Lifecycle** (`packages/gmail`) | Awaited canonical thread ID promise, cleared thread on route change, and awaited `Router.goto` | Prevents race condition during thread view destruction and stale `currentThread` leakage onto inbox/search views. |
| **AI Job Lifecycle & Cache Bypass** (`packages/ai`, `packages/agent`) | Added `bypassCache: Boolean(force)` to AI queue, timeout abort handling, and in-flight job ownership check | Ensures forced regenerate requests bypass stale caches, aborted jobs do not pollute cache/metrics, and concurrent jobs don't clobber state. |
| **Draft Linkage & Dexie v4** (`packages/mailbox`, `packages/agent`, `apps/extension`) | Added `resultId` index to `ai_jobs` table in Dexie v4 and direct draft resolution in background | Connects completed draft job results directly to their generated Dexie drafts, eliminating fingerprint lookup ambiguity. |
| **Content Script Secrets Isolation** (`packages/shared`, `apps/extension`) | Introduced `PublicExtensionSettings` (`toPublicSettings()`) and manifest wildcard permission | Strips `personalApiToken` and `aiApiKey` from content script exposure while permitting custom remote AI provider endpoints. |

### Detailed Changes

#### Added
- **`apps/extension`**: Added `SelfViewDeduplicator` with multi-tier source priority (`MESSAGE_EXPANDED` / `MESSAGE_LOAD` > `ROW_INTERACTION`).
- **`apps/extension`**: Added unit tests in `apps/extension/src/content/self-view-dedupe.test.ts`.
- **`packages/shared`**: Added `PublicExtensionSettings`, `toPublicSettings()`, and `GET_PUBLIC_SETTINGS` runtime message schema.
- **`packages/mailbox`**: Added Dexie v4 migration with `resultId` index on `ai_jobs` table.
- **`packages/tracking`**, **`workers/tracker`**, **`convex`**: Added `ClickClassification` (`RECIPIENT_LIKELY`, `SELF_LIKELY`, `MACHINE_LIKELY`, `UNKNOWN`) and `classifyClick()` / `classifyClickEvent()`.
- **`apps/extension/manifest.json`**: Added `"https://*/*"` to `optional_host_permissions` for custom remote AI endpoints.

#### Changed / Refactored
- **`packages/tracking`**: Updated `deriveTrackingStats()` to increment `clickCount` only for `RECIPIENT_LIKELY` clicks; exposes `pixelLoadCount` and `possibleOpenCount`.
- **`workers/tracker` & `convex`**: In `handleSelfView` / `recordSelfView`, retroactively reclassifies correlated clicks within the self-view window to `SELF_LIKELY`.
- **`convex/tracking`**: Replaced `.take(200)` truncation with unbounded `getAllEventsForEmail()` collector while maintaining O(1) incremental counter updates.
- **`packages/ai`**: `AIJobQueue.enqueue` accepts `bypassCache`, `signal`, and `timeoutMs`, aborting provider requests on timeout and preventing late cache writes.
- **`packages/agent`**: `startSummaryJob` and `startDraftJob` pass `bypassCache: Boolean(input.force)`, enforce in-flight job ownership, and populate `resultId` on draft completion.
- **`apps/extension`**: Content script requests `GET_PUBLIC_SETTINGS` and isolates API tokens to background service worker.

#### Fixed
- **Thread ID Promise Equality Bug**: In `InboxSdkAdapter`, resolved canonical thread ID before destruction check, fixing `this.currentThread?.threadId !== threadView.getThreadID()` promise-vs-string bug.
- **Non-Thread Route Stale State**: Cleared `this.currentThread = null` when navigating to non-thread views (`inbox`, `search`, etc.).
- **Unchecked Router Goto**: Properly awaited `Promise.resolve(this.sdk.Router.goto?.(...))`.
- **Reinspection Timestamp Mutation**: In `message-self-view.ts`, preserved original `expandedAt` timestamp across view mutations during `reinspectActive()`.
- **Row Triage False Self-Opens**: Screened row interaction targets in `sent-status.ts` to ignore clicks on stars, checkboxes, action buttons, and chips.
- **Draft Status Resolution Race**: In background `GET_AI_JOB_STATUS`, checked `job.resultId` first before falling back to draft fingerprint search.
- **Bare Catches in Extension**: Replaced silent catch blocks in InboxSDK handler registration with structured bounded debug logs.

### Verification Proof
- `npm test`: 28 test files passed, 251 tests passed.
- `npm run typecheck`: Passed with 0 TypeScript errors across all workspaces.
- `npm run lint`: Passed with 0 errors across packages, apps, and workers.
- `npm run build`: Production build verified for all workspaces (`@gi/shared`, `@gi/gmail`, `@gi/mailbox`, `@gi/ai`, `@gi/search`, `@gi/agent`, `@gi/tracking`, `@gi/extension`, `@gi/tracker`).

