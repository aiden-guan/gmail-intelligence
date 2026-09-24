# Changelog

All notable changes to Gmail Intelligence are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — 2026-09-24

### Summary
Implemented a durable sender self-open suppression architecture based on exact message identity, separated message render milestones, and one-shot server-side self-view claims, completely replacing fixed timestamp-window correlation.

### Architectural & Functional Highlights
| Component / Layer | Change | Impact |
| :--- | :--- | :--- |
| **One-Shot Self-View Claims** (`workers/tracker`, `convex`, `supabase`) | Added short-lived (25s) exact-message self-view claims consumed atomically by sender pixels | Prevents delayed Gmail image loads (>8s) from triggering false recipient opens, while immediately allowing subsequent recipient opens. |
| **Separated Render Milestones** (`apps/extension`) | Separated `expandedAt` and `loadedAt` into independent state milestones in `ActiveMessageViewState` | `MESSAGE_LOAD` uses its actual load timestamp and strengthens the claim without reusing stale `expandedAt`. |
| **Priority Deduplication** (`apps/extension`) | Allowed stronger signals (`MESSAGE_LOAD`) to upgrade claims even after `MESSAGE_EXPANDED` or `CACHE_REINSPECTION` | Ensures sender claims stay active during slow Gmail proxy renders without dropping render milestones. |
| **Delivery Retries & Idempotency** (`apps/extension`, `packages/tracking`) | Added exponential retry (3 attempts) with deterministic `selfViewEventId` idempotency key | Prevents transient delivery failures from disabling sender suppression; backend safely upserts single logical claim. |
| **Tracker Protocol v3 & Health Diagnostics** (`packages/tracking`, `workers/tracker`, `convex`, `apps/extension`) | Introduced protocol version 3 and feature negotiation (`self_view_claims`) | Settings & diagnostics detect and warn on outdated tracker deployments instead of falsely reporting healthy. |
| **Supabase & Convex Parity** (`supabase/migrations`, `convex`) | Added `tracking_self_view_claims` table, indexes, and updated classification check constraint | Added full support for `PROXY_LIKELY` and `MACHINE_LIKELY` alongside claims in Supabase and Convex. |

### Detailed Changes

#### Added
- **`supabase/migrations`**: Created `20260924000000_self_view_claims.sql` adding `tracking_self_view_claims` table and expanding `tracking_events` check constraint to include `PROXY_LIKELY` and `MACHINE_LIKELY`.
- **`convex/schema.ts` & `convex/tracking.ts`**: Added `selfViewClaims` table schema, indexes, atomic claim consumption, render-burst grace window, and retroactive reclassification.
- **`convex/tracking.test.ts`**: Added comprehensive mutation test suite for Convex tracking claims and race conditions.
- **`workers/tracker`**: Added `ClaimRow` and claims methods to `TrackerStore`, implemented in `MemoryTrackerStore` and `SupabaseTrackerStore`.
- **`packages/tracking`**: Added `SelfViewClaim` interface, `SelfViewAck`, protocol versioning constants (`TRACKER_PROTOCOL_VERSION = 3`), and feature requirements.
- **`packages/shared`**: Updated `RuntimeMessageSchema` to include `source`, `selfViewEventId`, and `retryCount` for `TRACKING_SELF_VIEW`.

#### Changed / Refactored
- **`apps/extension/message-self-view.ts`**: Captured distinct `loadedAt` on MessageView `load` events, completely removing `expandedAt` reuse.
- **`apps/extension/self-view-dedupe.ts`**: Upgraded priority rules so `MESSAGE_LOAD` is never deduped against weaker signals.
- **`apps/extension/background`**: Replaced silent catch with bounded retry loop using `selfViewEventId`; reported diagnostic health status to session storage.
- **`workers/tracker/index.ts` & `convex/tracking.ts`**: Bypassed legacy timestamp window correlation when claims exist (`!hasClaims(trackingId)`), eliminating false suppression of subsequent recipient opens.
- **`packages/agent`**: Added random entropy suffix to `jobId` generation to prevent same-millisecond ID collisions in tests.

#### Fixed
- **Delayed Gmail Pixel Open Regression**: Pixel arriving >8s after expansion now safely matches active or refreshed claim and is classified as `SELF_LIKELY`.
- **False Suppression of Real Recipient Opens**: Recipient opens arriving >1000ms after claim consumption are no longer swallowed by the legacy 8-second window.
- **Outdated Tracker Silent Failure**: Extensions now detect when deployed trackers lack self-view claims and flag the tracker as outdated.
- **Supabase Constraint Violations**: Runtime classifications `PROXY_LIKELY` and `MACHINE_LIKELY` are now valid enum values in Postgres.

### Verification Proof
- `npm test`: 29 test files passed, 283 tests passed.
- `npm run typecheck`: Passed with 0 TypeScript errors across all workspaces and Convex.
- `npm run lint`: Passed with 0 errors across packages, apps, and workers.
- `npm run build`: Production build verified for all workspaces (`@gi/shared`, `@gi/gmail`, `@gi/mailbox`, `@gi/ai`, `@gi/search`, `@gi/agent`, `@gi/tracking`, `@gi/extension`, `@gi/tracker`).

---

## [0.1.0] — 2026-09-24

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

