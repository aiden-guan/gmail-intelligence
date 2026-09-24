import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExtensionSettings } from '@gi/shared';
import { DEFAULT_SETTINGS, localThreadSummary } from '@gi/shared';
import {
  CompositeGmailAdapter,
  findComposeBody,
  findNotice,
  resolveThreadId,
  findThreadRows,
  normalizeOpenedThread,
  normalizeVisibleRow,
  type NormalizedThread,
  selectorDiagnostics,
  verifyArchive,
  verifyDraftInserted,
  verifyNavigation,
  type InboxSdkLike,
  type QueuedGmailAction,
} from '@gi/gmail';
import type { CreateTrackedEmailInput, CreateTrackedEmailResult, TrackedEmailPatch, TrackedEmailSummary } from '@gi/tracking';
import { applyCategoryChip, rowsForThread } from './chips';
import { VISIBLE_COMMANDS, isVisibleCommand, type CommandId } from './commands';
import { attachSdkComposeTracking, type ComposeTrackingSession } from './compose-tracking';
import { installSentStatus, type SentStatusController } from './sent-status';
import { SURFACE_CSS, ensureSurface, floatPanelRightPx, shadowMount } from './surface';
import { ThreadIntelCard, type IslandMode, type ThreadIntelData } from './thread-panel';
import { showToast } from './toasts';

const adapter = new CompositeGmailAdapter();
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let sdkReady = false;
let sdkOwnsCompose = false;
let sentStatus: SentStatusController | null = null;
let booted = false;
let paletteBound = false;
const panelRoots = new Map<HTMLElement, Root>();
let islandMode: IslandMode | null = null;
let currentThreadId: string | null = null;
const summaryNotes = new Map<string, { pending: boolean; reason: string | null; preview: string | null }>();
const summaryKeys = new Map<string, string>();

function runtimeAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function send<T>(message: unknown, timeoutMs = 12_000): Promise<T | undefined> {
  if (!runtimeAlive()) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);

    try {
      const pending = chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!runtimeAlive() || chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve(response as T);
      });
      void Promise.resolve(pending).catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      });
    } catch {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

async function refreshSettings(): Promise<void> {
  const res = await send<{ settings?: ExtensionSettings }>({ type: 'GET_SETTINGS' });
  if (res?.settings) settings = res.settings;
}

async function tryLoadInboxSdk(): Promise<InboxSdkLike | null> {
  const appId = settings.inboxSdkAppId.trim();
  if (!appId) return null;
  try {
    const mod = await import('@inboxsdk/core');
    const loader = (mod as { load?: (version: number, appId: string, opts?: { appName?: string }) => Promise<unknown> }).load;
    if (!loader) return null;
    return (await loader(2, appId, { appName: 'Gmail Intelligence' })) as InboxSdkLike;
  } catch (error) {
    console.warn('[gi] InboxSDK failed to load', error);
    return null;
  }
}

function reportRuntime(lastAction?: { success: boolean; action: string; reason?: string }): void {
  const diagnostics = selectorDiagnostics(document);
  const integration = adapter.getActiveIntegration();
  const rowsOk = diagnostics.find((item) => item.key === 'threadRow')?.found;
  const threadOk = diagnostics.find((item) => item.key === 'openThread')?.found;
  const onList = /#(inbox|search|sent|starred)/i.test(location.hash);
  void send({
    type: 'REPORT_RUNTIME',
    runtime: {
      connected: true,
      integration: integration || 'unavailable',
      inboxSdk: sdkReady ? 'loaded' : 'failed',
      domFallback: !onList || rowsOk || threadOk ? 'healthy' : 'selector issue',
      lastEvent: adapter.bus.getLastEvent()
        ? { type: adapter.bus.getLastEvent()!.type, at: adapter.bus.getLastEvent()!.at }
        : null,
      currentThreadId,
      lastAction: lastAction ? { ...lastAction, at: Date.now() } : undefined,
    },
  });
}

function currentIslandMode(): IslandMode {
  if (islandMode) return islandMode;
  try {
    const stored = sessionStorage.getItem('gi.island');
    if (stored === 'docked' || stored === 'open' || stored === 'expanded') {
      islandMode = stored === 'expanded' ? 'open' : stored;
      return islandMode;
    }
  } catch {
    /* sessionStorage can throw on hardened pages */
  }
  islandMode = 'open';
  return 'open';
}

async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  ensureSurface();
  await refreshSettings();
  const sdk = await tryLoadInboxSdk();
  if (sdk) {
    const bound = adapter.bindInboxSdk(sdk);
    sdkReady = bound;
    if (bound) mountSdkUi(sdk);
  }
  reportTracking(null);
  await adapter.start((event) => {
    if (event.type === 'VISIBLE_ROWS_CHANGED') {
      const threads = event.rows.map((row) => normalizeVisibleRow(row, adapter.getActiveIntegration() === 'inboxsdk' ? 'inboxsdk' : 'dom'));
      if (threads.length) {
        void send({ type: 'INGEST_THREADS', direction: 'inbound', threads });
        void paintVisibleChips(threads.map((thread) => thread.threadId));
      }
    }
    if (event.type === 'THREAD_OPENED' || event.type === 'THREAD_DATA_UPDATED') {
      currentThreadId = event.thread.threadId;
      const thread = normalizeOpenedThread(event.thread, adapter.getActiveIntegration() === 'inboxsdk' ? 'inboxsdk' : 'dom');
      const bodyKey = `${thread.threadId}:${thread.messages.map((message) => message.bodyText.length).join(',')}`;
      if (summaryKeys.get(thread.threadId) !== bodyKey) {
        summaryKeys.set(thread.threadId, bodyKey);
        void summarizeOpenThread(thread);
      }
      if (!sdkReady) showDomThreadPanel(event.thread.threadId);
    }
    if (event.type === 'COMPOSE_OPENED' && !sdkOwnsCompose) {
      reportTracking(null);
    }
    if (event.type === 'ROUTE_CHANGED' && !/#\/[A-Za-z0-9]/.test(location.hash)) {
      currentThreadId = null;
      hideDomThreadPanel();
    }
    reportRuntime();
  });
  sentStatus = installSentStatus({
    trackerBaseUrl: settings.trackerBaseUrl,
    onNotify: (trackingId, enabled) => {
      void send<{ emails?: TrackedEmailSummary[] }>({ type: 'SET_NO_REPLY_NOTIFY', trackingId, enabled }).then((res) => {
        if (Array.isArray(res?.emails)) sentStatus?.setEmails(res.emails);
      });
    },
    onStatus: () => {
      if (!currentThreadId) return;
      const panel = document.getElementById('gi-thread-panel');
      if (panel) void refreshPanel(panel, currentThreadId);
    },
    onLink: (trackingId, gmailThreadId) => {
      linkTracked({ trackingId, gmailThreadId, gmailMessageId: null });
    },
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue && typeof changes.settings.newValue === 'object') {
      settings = { ...settings, ...(changes.settings.newValue as ExtensionSettings) };
      sentStatus?.setTrackerBaseUrl(settings.trackerBaseUrl || '');
    }
    if (area === 'local' && Array.isArray(changes.trackedEmails?.newValue)) {
      sentStatus?.setEmails(changes.trackedEmails.newValue as TrackedEmailSummary[]);
    }
    if (area === 'session' && changes.intelPulse?.newValue?.threadId) {
      const threadId = String(changes.intelPulse.newValue.threadId);
      void refreshThread(threadId);
    }
  });
  void send<{ emails?: TrackedEmailSummary[] }>({ type: 'GET_TRACKED_EMAILS' }).then((res) => {
    if (Array.isArray(res?.emails)) sentStatus?.setEmails(res.emails);
  });
  setupCommandPalette();
  const pullTracking = () => {
    if (document.visibilityState === 'hidden') return;
    void send({ type: 'TRACKING_POLL' });
  };
  pullTracking();
  window.setInterval(pullTracking, 12_000);
  document.addEventListener('visibilitychange', pullTracking);
  reportRuntime();
}

function trackingDeps() {
  return {
    getSettings: () => settings,
    refreshSettings,
    createTracked,
    markSent,
    cancelTracked,
    syncLinks,
    reportDiagnostics: reportTracking,
    onSent: ({ subject, recipients, bodyText }: { subject: string; recipients: string[]; bodyText: string }) => {
      void send({ type: 'OUTGOING_COMPOSE', subject, recipients, bodyText, threadId: currentThreadId || 'sent' });
    },
  };
}

function reportTracking(session: ComposeTrackingSession | null): void {
  const head = document.head;
  void send({
    type: 'REPORT_TRACKING',
    report: {
      inboxSdkLoaded: sdkReady,
      composeHookAttached: sdkOwnsCompose,
      pageWorldInjected: head?.getAttribute('data-inboxsdk-script-injected') === 'true',
      pageWorldReady: Boolean(head?.getAttribute('data-inboxsdk-user-email-address')),
      last: session
        ? {
            composeSessionId: session.composeSessionId,
            kind: session.kind,
            state: session.state,
            trackingId: session.trackingId,
            allocation: Boolean(session.trackingId),
            draftId: Boolean(session.gmailDraftId),
            modifierRegistered: session.modifierRegistered,
            modifierInvoked: session.modifierInvocationCount > 0,
            pixelPresent: session.modifierSawPixel,
            gmailSent: session.state === 'SENT',
            gmailIdsLinked: Boolean(session.gmailThreadId || session.gmailMessageId),
            lastError: session.lastError,
            logs: session.logs,
          }
        : null,
    },
  });
}

function mountSdkUi(sdk: InboxSdkLike): void {
  try {
    sdk.Lists.registerThreadRowViewHandler(async (rowView) => {
      const threadId = await resolveThreadId(rowView);
      const rowElement = typeof rowView.getElement === 'function' ? rowView.getElement() : null;
      const threadRow = rowElement?.closest?.('tr.zA, tr[data-legacy-thread-id], div[role="listitem"]') || rowElement;
      if (threadRow instanceof HTMLElement && typeof threadId === 'string') {
        threadRow.setAttribute('data-gi-thread-id', threadId);
        sentStatus?.paint();
      }
    });
  } catch {
    /* row stamps are optional */
  }
  try {
    sdk.Conversations.registerThreadViewHandler((threadView) => {
      void mountSdkSidebar(threadView);
    });
  } catch {
    /* sidebar is optional */
  }
  try {
    sdk.Compose.registerComposeViewHandler((composeView) => {
      attachSdkComposeTracking(composeView, trackingDeps());
    });
    sdkOwnsCompose = true;
  } catch {
    sdkOwnsCompose = false;
  }
  try {
    const splits: Array<[string, string]> = [
      ['Priority', 'PRIORITY'],
      ['Respond', 'RESPOND'],
      ['Waiting', 'WAITING'],
      ['FYI', 'FYI'],
      ['Notifications', 'NOTIFICATIONS'],
      ['Promotions', 'PROMOTIONS'],
      ['News', 'NEWS'],
      ['Follow-ups', 'FOLLOW_UPS'],
    ];
    for (const [name, category] of splits) {
      sdk.NavMenu?.addNavItem({
        name,
        routeID: `gi/${category.toLowerCase()}`,
        onClick: () => {
          void send({ type: 'OPEN_SPLIT', category });
        },
      });
    }
  } catch {
    /* nav is optional */
  }
}

async function mountSdkSidebar(threadView: {
  getThreadID?: () => string | null | undefined | Promise<string | null | undefined>;
  getThreadIDAsync?: () => string | Promise<string | null | undefined>;
  addSidebarContentPanel?: (desc: unknown) => void;
}): Promise<void> {
  const threadId = (await resolveThreadId(threadView)) || '';
  if (!threadId || !threadView.addSidebarContentPanel) return;
  const el = document.createElement('div');
  el.setAttribute('data-gi-ui', 'thread-sidebar');
  el.style.padding = '0';
  el.style.background = 'transparent';
  threadView.addSidebarContentPanel({
    title: 'Intelligence',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    el,
  });
  currentThreadId = threadId;
  await refreshPanel(el, threadId);
}

function placeFloatPanel(panel: HTMLElement): void {
  const main = document.querySelector<HTMLElement>('[role="main"]');
  const rect = main?.getBoundingClientRect();
  const scrollbar = main ? Math.max(0, main.offsetWidth - main.clientWidth) : 0;
  const right = rect ? floatPanelRightPx(window.innerWidth, rect.right, scrollbar) : 28;
  panel.style.setProperty('right', `${right}px`, 'important');
}

function showDomThreadPanel(threadId: string): void {
  ensureSurface();
  let panel = document.getElementById('gi-thread-panel');
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = 'gi-thread-panel';
    panel.setAttribute('data-gi-ui', 'thread-panel');
    panel.addEventListener('mousedown', (event) => event.stopPropagation());
    panel.addEventListener('click', (event) => event.stopPropagation());
    document.documentElement.append(panel);
    window.addEventListener('resize', () => {
      const current = document.getElementById('gi-thread-panel');
      if (current) placeFloatPanel(current);
    });
  }
  placeFloatPanel(panel);
  void refreshPanel(panel, threadId);
}

function hideDomThreadPanel(): void {
  const panel = document.getElementById('gi-thread-panel');
  if (!panel) return;
  const mount = panel.shadowRoot?.querySelector<HTMLElement>('#gi-mount');
  if (mount) {
    panelRoots.get(mount)?.unmount();
    panelRoots.delete(mount);
  }
  panelRoots.get(panel)?.unmount();
  panelRoots.delete(panel);
  panel.remove();
}

async function refreshThread(threadId: string): Promise<void> {
  for (const row of rowsForThread(threadId)) {
    const intel = await getIntel(threadId);
    const category = intel?.classification?.category;
    if (category) applyCategoryChip(row, category, Boolean(intel?.manual));
  }
  const panel = document.getElementById('gi-thread-panel');
  if (panel && currentThreadId === threadId) await refreshPanel(panel, threadId);
  document.querySelectorAll<HTMLElement>('[data-gi-ui="thread-sidebar"]').forEach((el) => {
    if (currentThreadId === threadId) void refreshPanel(el, threadId);
  });
}

async function paintVisibleChips(threadIds: string[]): Promise<void> {
  const res = await send<{ intel?: Record<string, ThreadIntelData> }>({ type: 'GET_THREAD_INTEL_MANY', threadIds });
  const intel = res?.intel || {};
  for (const threadId of threadIds) {
    const category = intel[threadId]?.classification?.category;
    if (!category) continue;
    for (const row of rowsForThread(threadId)) applyCategoryChip(row, category, Boolean(intel[threadId]?.manual));
  }
}

async function refreshPanel(el: HTMLElement, threadId: string): Promise<void> {
  const host = el.id === 'gi-mount' ? ((el.getRootNode() as ShadowRoot).host as HTMLElement) : el;
  const variant = host.getAttribute('data-gi-ui') === 'thread-sidebar' ? 'sidebar' : 'float';
  const mount = shadowMount(host);
  const intel = await getIntel(threadId);
  let root = panelRoots.get(mount);
  if (!root) {
    root = createRoot(mount);
    panelRoots.set(mount, root);
  }
  const tracking = sentStatus?.openThreadStatus() ?? null;
  const note = summaryNotes.get(threadId);
  const summaryLine = intel?.summary?.summary?.oneLine;
  const preview = summaryLine ? null : note?.preview || null;
  const pending = summaryLine
    ? null
    : preview
      ? null
      : note?.pending
        ? 'Analyzing thread…'
        : note?.reason || (intel?.classification ? null : 'Analyzing thread…');
  root.render(
    createElement(ThreadIntelCard, {
      intel,
      tracking,
      pending,
      preview,
      mode: currentIslandMode(),
      variant,
      onMode: (mode) => {
        islandMode = mode;
        try {
          sessionStorage.setItem('gi.island', mode);
        } catch {
          /* ignore */
        }
        void refreshPanel(host, threadId);
        if (host.id === 'gi-thread-panel') {
          document.querySelectorAll<HTMLElement>('[data-gi-ui="thread-sidebar"]').forEach((node) => {
            void refreshPanel(node, threadId);
          });
        } else {
          const floatHost = document.getElementById('gi-thread-panel');
          if (floatHost) void refreshPanel(floatHost, threadId);
        }
      },
      onDraft: () => void draftReply(threadId),
      onRemind: () => void remind(threadId),
    }),
  );
}

function previewLine(thread: NormalizedThread): string | null {
  if (!thread.messages.some((message) => message.bodyText.trim())) return null;
  const line = localThreadSummary({
    subject: thread.subject,
    messages: thread.messages.map((message) => ({ bodyText: message.bodyText })),
  }).oneLine.trim();
  return line && line !== 'Empty message' ? line : null;
}

async function summarizeOpenThread(thread: NormalizedThread): Promise<void> {
  const hasBody = thread.messages.some((message) => message.bodyText.trim().length > 0);
  const preview = previewLine(thread);
  summaryNotes.set(thread.threadId, {
    pending: hasBody && !preview,
    reason: null,
    preview,
  });
  await refreshThread(thread.threadId);

  try {
    const direction = thread.route === 'sent' ? 'outbound' : 'inbound';
    const ingestPromise = send({ type: 'INGEST_THREAD', direction, thread });
    if (!hasBody) {
      summaryNotes.set(thread.threadId, {
        pending: false,
        reason: 'The message text is not on screen yet.',
        preview: null,
      });
      await refreshThread(thread.threadId);
      await ingestPromise;
      return;
    }
    const res = await send<{ ok?: boolean; oneLine?: string; reason?: string }>({
      type: 'SUMMARIZE_THREAD',
      threadId: thread.threadId,
      subject: thread.subject,
      messages: thread.messages.map((message) => ({
        sender: message.sender?.email || 'unknown@local',
        bodyText: message.bodyText,
        timestamp: message.timestamp || '',
      })),
    });
    const fallback = res?.ok ? null : (preview || previewLine(thread));
    summaryNotes.set(thread.threadId, {
      pending: false,
      reason: res?.ok ? null : res?.reason || null,
      preview: fallback,
    });
    await refreshThread(thread.threadId);
    await ingestPromise;
  } catch (error) {
    console.warn('[gi] summarizeOpenThread error', error);
    summaryNotes.set(thread.threadId, {
      pending: false,
      reason: null,
      preview: preview || previewLine(thread),
    });
    await refreshThread(thread.threadId);
  } finally {
    const current = summaryNotes.get(thread.threadId);
    if (current?.pending) {
      summaryNotes.set(thread.threadId, {
        pending: false,
        reason: current.reason,
        preview: current.preview || previewLine(thread),
      });
      await refreshThread(thread.threadId);
    }
  }
}

function getIntel(threadId: string): Promise<ThreadIntelData | undefined> {
  return send<ThreadIntelData>({ type: 'GET_THREAD_INTEL', threadId });
}

async function createTracked(input: CreateTrackedEmailInput): Promise<CreateTrackedEmailResult | null> {
  const res = await send<{ ok?: boolean; tracking_id?: string; pixel_url?: string; rewritten_links?: CreateTrackedEmailResult['rewritten_links'] }>({
    type: 'CREATE_TRACKED_EMAIL',
    input,
  });
  if (!res?.ok || !res.tracking_id || !res.pixel_url) return null;
  return {
    tracking_id: res.tracking_id,
    pixel_url: res.pixel_url,
    rewritten_links: res.rewritten_links || [],
  };
}

function markSent(patch: TrackedEmailPatch & { trackingId: string }): void {
  void send({ type: 'MARK_TRACKED_SENT', ...patch }).then(() => {
    void send({ type: 'TRACKING_POLL' });
  });
}

function cancelTracked(trackingId: string): void {
  void send({ type: 'CANCEL_TRACKED_EMAIL', trackingId });
}

function syncLinks(update: { trackingId: string; links: Array<{ click_id: string; url: string }> }): void {
  void send({ type: 'SYNC_TRACKED_LINKS', ...update });
}

function linkTracked(link: { trackingId: string; gmailThreadId: string | null; gmailMessageId: string | null }): void {
  void send({ type: 'LINK_TRACKED_EMAIL', ...link }).then(() => {
    void send({ type: 'TRACKING_POLL' });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === 'THREAD_INTELLIGENCE_UPDATED') {
      await refreshThread(String(message.threadId || ''));
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'PERFORM_ACTION') {
      const action = message.action as QueuedGmailAction;
      const result = await runAction(action, message.insertText);
      reportRuntime({
        success: Boolean(result.success && result.verified !== false),
        action: action.kind,
        reason: result.reason || ('error' in result ? result.error : undefined),
      });
      sendResponse(result);
      return;
    }
    if (message?.type === 'INDEX_FETCH_BATCH') {
      sendResponse(await indexBatch(String(message.query || 'in:inbox'), String(message.cursor || '0')));
      return;
    }
    if (message?.type === 'HYDRATE_THREAD') {
      sendResponse(await hydrateThread(String(message.threadId || ''), message.restore !== false));
      return;
    }
    if (message?.type === 'GET_CAPABILITIES') {
      sendResponse(await adapter.detectCapabilities());
    }
  })();
  return true;
});

async function runAction(action: QueuedGmailAction, insertText?: string) {
  if (action.kind === 'ARCHIVE_THREAD') return archiveThread(action.threadId);
  if (action.kind === 'CREATE_REPLY_DRAFT' && insertText) return insertDraft(action.threadId, insertText);
  if (action.kind === 'NAVIGATE_SEARCH') {
    const result = await adapter.actions.enqueueAndWait(action, {
      verify: async () => verifyNavigation(location.hash, action.query).verified,
    });
    return { ...result, reason: result.reason || result.error, verified: Boolean(result.verified) };
  }
  const result = await adapter.actions.enqueueAndWait(action);
  return { ...result, reason: result.reason || result.error, verified: Boolean(result.verified) };
}

async function archiveThread(threadId: string) {
  const before = await inspect(threadId);
  const result = await adapter.actions.enqueueAndWait(
    { kind: 'ARCHIVE_THREAD', threadId },
    {
      maxAttempts: 2,
      verify: async () => {
        await wait(500);
        const after = await inspect(threadId);
        return verifyArchive({
          toastText: after.toastText,
          beforeOpenThreadId: before.openThreadId,
          afterOpenThreadId: after.openThreadId,
          expectedThreadId: threadId,
          inboxContainsThread: after.inboxContainsThread,
        }).verified;
      },
    },
  );
  const verified = Boolean(result.verified);
  return {
    ...result,
    success: result.success && verified,
    verified,
    action: 'ARCHIVE_THREAD',
    threadId,
    reason: verified ? 'Archived' : result.reason || result.error || 'Could not archive',
  };
}

async function waitForComposeBody(timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const compose = await adapter.getCurrentCompose();
    if (compose.compose) return true;
    if (typeof document !== 'undefined' && findComposeBody(document)) return true;
    await wait(100);
  }
  return false;
}

async function insertDraft(threadId: string, text: string) {
  const opened = await adapter.actions.enqueueAndWait({ kind: 'CREATE_REPLY_DRAFT', threadId });
  if (!opened.success) {
    return { success: false, verified: false, action: 'CREATE_REPLY_DRAFT', threadId, reason: opened.reason || 'Could not open reply' };
  }
  await waitForComposeBody(4000);
  await adapter.insertComposeBody(text);
  await wait(300);
  const compose = await adapter.getCurrentCompose();
  const thread = await adapter.getCurrentThread();
  const currentBody = compose.compose?.bodyText || (typeof document !== 'undefined' ? findComposeBody(document)?.textContent || '' : '');
  const check = verifyDraftInserted({
    composeOpen: Boolean(compose.compose) || Boolean(typeof document !== 'undefined' && findComposeBody(document)),
    bodyText: currentBody,
    expectedText: text,
    activeThreadId: thread.thread?.threadId ?? null,
    expectedThreadId: threadId,
  });
  return {
    success: check.verified,
    verified: check.verified,
    action: 'CREATE_REPLY_DRAFT',
    threadId,
    reason: check.reason,
  };
}

async function inspect(threadId: string) {
  const current = await adapter.getCurrentThread();
  const openThreadId = current.thread?.threadId ?? null;
  const rows = findThreadRows(document);
  const onList = rows.length > 0 && !openThreadId;
  return {
    toastText: findNotice(document),
    openThreadId,
    inboxContainsThread: onList ? rows.some((row) => row.getAttribute('data-legacy-thread-id') === threadId || row.getAttribute('data-gi-thread-id') === threadId) : null,
  };
}

async function indexBatch(query: string, cursor: string) {
  const page = Number(cursor) || 0;
  if (page === 0) {
    await adapter.navigateToSearch(query);
    await wait(1200);
  }
  const rows = await adapter.getVisibleThreadMetadata();
  const threads = (rows.rows || []).map((row) => normalizeVisibleRow(row, 'dom', 'search'));
  return { threads, nextCursor: threads.length && page < 8 ? String(page + 1) : undefined };
}

async function hydrateThread(threadId: string, restore: boolean) {
  const previous = location.hash;
  location.hash = `#inbox/${threadId}`;
  await wait(1400);
  const current = await adapter.getCurrentThread();
  const thread = current.thread ? normalizeOpenedThread(current.thread, 'hydrated') : null;
  if (restore) location.hash = previous;
  return { thread };
}

function setupCommandPalette(): void {
  if (paletteBound) return;
  paletteBound = true;
  document.addEventListener('keydown', (event) => {
    if (!settings.commandPaletteEnabled) return;
    const mod = navigator.platform.includes('Mac') ? event.metaKey : event.ctrlKey;
    if (!mod || event.key.toLowerCase() !== 'k') return;
    const target = event.target as HTMLElement | null;
    if (!settings.commandPaletteOverrideGmail && target?.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    openCommandPalette();
  }, true);
}

function openCommandPalette(): void {
  if (document.querySelector('[data-gi-ui="cmdk"]')) return;
  ensureSurface();
  const host = document.createElement('div');
  host.setAttribute('data-gi-ui', 'cmdk');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SURFACE_CSS;
  const scrim = document.createElement('div');
  scrim.className = 'gi-cmdk';
  const panel = document.createElement('div');
  panel.className = 'gi-cmdk-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Commands');
  const core = document.createElement('div');
  core.className = 'gi-cmdk-core';
  const input = document.createElement('input');
  input.className = 'gi-cmdk-input';
  input.placeholder = 'Search commands';
  input.setAttribute('aria-label', 'Search commands');
  const list = document.createElement('div');
  list.className = 'gi-cmdk-list';
  list.setAttribute('role', 'listbox');
  const foot = document.createElement('div');
  foot.className = 'gi-cmdk-foot';
  foot.innerHTML = '<span><kbd class="gi-kbd">↑↓</kbd> move</span><span><kbd class="gi-kbd">↵</kbd> run</span><span><kbd class="gi-kbd">esc</kbd> close</span>';

  let active = 0;
  let items: HTMLButtonElement[] = [];

  const close = () => {
    window.removeEventListener('keydown', onWindowKey, true);
    host.remove();
  };
  const onWindowKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const choose = (index: number) => {
    const id = items[index]?.dataset.command;
    if (!id) return;
    close();
    void runCommand(id);
  };
  const paintActive = (scroll = false) => {
    items.forEach((row, index) => {
      const on = index === active;
      row.dataset.active = on ? 'true' : 'false';
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (scroll) items[active]?.scrollIntoView({ block: 'nearest' });
  };
  const render = (filter: string) => {
    list.replaceChildren();
    items = [];
    const commands = VISIBLE_COMMANDS.filter((item) => item.label.toLowerCase().includes(filter.toLowerCase()));
    if (active >= commands.length) active = 0;
    if (!commands.length) {
      const empty = document.createElement('div');
      empty.className = 'gi-cmdk-empty';
      empty.textContent = 'No matching commands';
      list.append(empty);
      return;
    }
    commands.forEach((command, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'gi-cmdk-row';
      row.dataset.command = command.id;
      row.dataset.active = index === active ? 'true' : 'false';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === active ? 'true' : 'false');
      row.textContent = command.label;
      row.onmouseenter = () => {
        active = index;
        paintActive();
      };
      row.onclick = () => choose(index);
      items.push(row);
      list.append(row);
    });
  };

  input.oninput = () => {
    active = 0;
    render(input.value);
  };
  input.onkeydown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      active = Math.min(active + 1, Math.max(items.length - 1, 0));
      paintActive(true);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      active = Math.max(active - 1, 0);
      paintActive(true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      choose(active);
    }
  };
  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) close();
  });
  render('');
  core.append(input, list, foot);
  panel.append(core);
  scrim.append(panel);
  shadow.append(style, scrim);
  document.documentElement.append(host);
  window.addEventListener('keydown', onWindowKey, true);
  input.focus();
}

async function runCommand(id: string): Promise<void> {
  if (!isVisibleCommand(id)) {
    showToast('That command is not available.');
    return;
  }
  const command = id as CommandId;
  if (command === 'ask') {
    const res = await send<{ ok?: boolean; reason?: string }>({ type: 'FOCUS_SIDEPANEL', mode: 'ask' });
    if (!res?.ok) showToast(res?.reason || 'Could not open Ask Inbox.');
    return;
  }
  if (command === 'settings') {
    chrome.runtime.openOptionsPage();
    return;
  }
  const threadId = currentThreadId || (await adapter.getCurrentThread()).thread?.threadId;
  if (!threadId) {
    showToast('Open a thread first.');
    return;
  }
  if (command === 'summarize') {
    showToast('Summarizing…');
    const current = await adapter.getCurrentThread();
    const opened = current.thread;
    const res = await send<{ ok?: boolean; oneLine?: string; reason?: string }>({
      type: 'SUMMARIZE_THREAD',
      threadId,
      subject: opened?.subject || '',
      messages: (opened?.messages || []).map((message) => ({
        sender: message.sender?.email || 'unknown@local',
        bodyText: message.bodyText,
        timestamp: message.timestamp || '',
      })),
    });
    showToast(res?.ok ? res.oneLine || 'Summary ready.' : res?.reason || 'Could not summarize.');
    await refreshThread(threadId);
    return;
  }
  if (command === 'draft') {
    await draftReply(threadId);
    return;
  }
  if (command === 'remind') {
    await remind(threadId);
    return;
  }
  if (command === 'archive') {
    const result = await archiveThread(threadId);
    if (!result.success) showToast(result.reason || 'Could not archive.', () => void runCommand('archive'));
    else showToast('Archived.');
    return;
  }
  const category = command === 'mark_respond' ? 'RESPOND' : command === 'mark_waiting' ? 'WAITING' : 'FYI';
  const marked = await send<{ ok?: boolean; reason?: string }>({ type: 'SET_CATEGORY', threadId, category });
  showToast(marked?.ok ? `Marked ${category === 'RESPOND' ? 'Respond' : category === 'WAITING' ? 'Waiting' : 'FYI'}.` : marked?.reason || 'Could not update the category.');
  await refreshThread(threadId);
}

async function draftReply(threadId: string): Promise<void> {
  showToast('Drafting reply…');
  const current = await adapter.getCurrentThread();
  const thread = current.thread ? normalizeOpenedThread(current.thread, 'dom') : null;
  const res = await send<{ ok?: boolean; body?: string; reason?: string }>({
    type: 'DRAFT_REPLY',
    threadId,
    subject: thread?.subject,
    messages: thread?.messages.map((m) => ({
      sender: m.sender.email,
      bodyText: m.bodyText,
      timestamp: m.timestamp || '',
    })),
  });
  if (!res?.ok || !res.body) {
    showToast(res?.reason || 'Could not draft a reply.');
    return;
  }
  const inserted = await insertDraft(threadId, res.body);
  if (!inserted.success) showToast(inserted.reason || 'Could not insert the draft.', () => void draftReply(threadId));
  else showToast('Draft inserted. It was not sent.');
}

async function remind(threadId: string): Promise<void> {
  const res = await send<{ ok?: boolean; dueAt?: number; reason?: string }>({ type: 'REMIND_THREAD', threadId });
  if (!res?.ok) {
    showToast(res?.reason || 'Could not set a reminder.');
    return;
  }
  const when = res.dueAt ? new Date(res.dueAt).toLocaleDateString() : 'later';
  showToast(`Reminder set for ${when}.`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot().catch(() => undefined), { once: true });
else void boot().catch(() => undefined);
