# Phase 0 audit → implementation map

## Audit result (2026-03-22)

Repository was an **empty git repo** (no `package.json`, no apps). Greenfield build.

### 1. Existing functionality
None.

### 2. Reusable components
None — created monorepo from scratch with npm workspaces.

### 3. Missing systems (all implemented as V1)
Gmail adapter layer, mailbox IndexedDB, AI providers, search/RAG, agent loop, tracking worker, Supabase schema, extension UI, docs, tests.

### 4. Files modified
N/A (greenfield).

### 5. Files created
See README repo map: `apps/extension`, `packages/*`, `workers/tracker`, `supabase/migrations`, docs.

### 6. Architectural risks
- Gmail DOM / InboxSDK / Gmail.js fragility → capability detection + DOM fallback
- Native Gmail label mutation unreliable → virtual labels only (`persistentNativeLabelMutationAvailable: false`)
- No live Gmail verification in agent environment
- Custom tracker domains need optional host permission beyond `*.workers.dev`

### 7. Migration requirements
None (no prior schema).

## Research notes
- `@inboxsdk/core` ~2.2.x: MV3 requires local `pageWorld.js` + background injection via `chrome.scripting`
- `gmail-js` ~1.1.16: MAIN world only; optional capture, not sole source of truth
