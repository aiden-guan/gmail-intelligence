import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExtensionSettings } from '@gi/shared';
import { DEFAULT_SETTINGS } from '@gi/shared';
import {
  CompositeGmailAdapter,
  findNotice,
  findThreadRows,
  normalizeOpenedThread,
  normalizeVisibleRow,
  selectorDiagnostics,
  verifyArchive,
  verifyDraftInserted,
  verifyNavigation,
  type InboxSdkLike,
  type QueuedGmailAction,
} from '@gi/gmail';
import type { CreateTrackedEmailInput, CreateTrackedEmailResult, TrackedEmailSummary } from '@gi/tracking';
import { applyCategoryChip, rowsForThread } from './chips';
import { VISIBLE_COMMANDS, isVisibleCommand, type CommandId } from './commands';
import { attachSdkComposeTracking, installDomComposeTracking, prepareDomCompose } from './compose-tracking';
import { installSentStatus, type SentStatusController } from './sent-status';
import { ThreadIntelCard, type ThreadIntelData } from './thread-panel';
import { showToast } from './toasts';

const adapter = new CompositeGmailAdapter();
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let sdkReady = false;
let sdkOwnsCompose = false;
let sentStatus: SentStatusController | null = null;
let booted = false;
let paletteBound = false;
const panelRoots = new Map<HTMLElement, Root>();
let currentThreadId: string | null = null;

async function refreshSettings(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })) as { settings?: ExtensionSettings };
    if (res?.settings) settings = res.settings;
  } catch {
    /* settings stay at the last known value */
  }
}

async function tryLoadInboxSdk(): Promise<InboxSdkLike | null> {
  const appId = settings.inboxSdkAppId.trim();
  if (!appId) return null;
  try {
    await chrome.runtime.sendMessage({ type: 'ENSURE_INBOXSDK_PAGEWORLD' }).catch(() => undefined);
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
  chrome.runtime.sendMessage({
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
  }).catch(() => undefined);
}

async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  await refreshSettings();
  const sdk = await tryLoadInboxSdk();
  if (sdk) {
    const bound = adapter.bindInboxSdk(sdk);
    sdkReady = bound;
    if (bound) mountSdkUi(sdk);
  }
  await adapter.start((event) => {
    if (event.type === 'VISIBLE_ROWS_CHANGED') {
      const threads = event.rows.map((row) => normalizeVisibleRow(row, adapter.getActiveIntegration() === 'inboxsdk' ? 'inboxsdk' : 'dom'));
      if (threads.length) {
        chrome.runtime.sendMessage({ type: 'INGEST_THREADS', direction: 'inbound', threads });
        void paintVisibleChips(threads.map((thread) => thread.threadId));
      }
    }
    if (event.type === 'THREAD_OPENED' || event.type === 'THREAD_DATA_UPDATED') {
      currentThreadId = event.thread.threadId;
      const thread = normalizeOpenedThread(event.thread, adapter.getActiveIntegration() === 'inboxsdk' ? 'inboxsdk' : 'dom');
      chrome.runtime.sendMessage({ type: 'INGEST_THREAD', direction: 'inbound', thread });
      if (!sdkReady) showDomThreadPanel(event.thread.threadId);
    }
    if (event.type === 'COMPOSE_OPENED') {
      const compose = document.querySelector<HTMLElement>(`[data-gi-compose-id="${CSS.escape(event.compose.composeId)}"]`);
      if (compose && !sdkOwnsCompose) prepareDomCompose(compose, trackingDeps());
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
      chrome.runtime.sendMessage({ type: 'SET_NO_REPLY_NOTIFY', trackingId, enabled }, (res) => {
        if (Array.isArray(res?.emails)) sentStatus?.setEmails(res.emails);
      });
    },
  });
  installDomComposeTracking({ ...trackingDeps(), sdkOwnsCompose: () => sdkOwnsCompose });
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
  chrome.runtime.sendMessage({ type: 'GET_TRACKED_EMAILS' }, (res) => {
    if (Array.isArray(res?.emails)) sentStatus?.setEmails(res.emails);
  });
  setupCommandPalette();
  reportRuntime();
}

function trackingDeps() {
  return {
    getSettings: () => settings,
    refreshSettings,
    createTracked,
    linkTracked,
    onSent: ({ subject, recipients, bodyText }: { subject: string; recipients: string[]; bodyText: string }) => {
      chrome.runtime.sendMessage({ type: 'OUTGOING_COMPOSE', subject, recipients, bodyText, threadId: currentThreadId || 'sent' });
    },
  };
}

function mountSdkUi(sdk: InboxSdkLike): void {
  try {
    sdk.Lists.registerThreadRowViewHandler(async (rowView) => {
      const threadId = typeof rowView.getThreadIDAsync === 'function' ? await rowView.getThreadIDAsync() : rowView.getThreadID?.();
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
          chrome.runtime.sendMessage({ type: 'OPEN_SPLIT', category });
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
  const raw = threadView.getThreadIDAsync ? await threadView.getThreadIDAsync() : await threadView.getThreadID?.();
  const threadId = typeof raw === 'string' ? raw : '';
  if (!threadId || !threadView.addSidebarContentPanel) return;
  const el = document.createElement('div');
  el.setAttribute('data-gi-ui', 'thread-sidebar');
  el.style.padding = '8px 4px';
  threadView.addSidebarContentPanel({
    title: 'Intelligence',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    el,
  });
  currentThreadId = threadId;
  await refreshPanel(el, threadId);
}

function showDomThreadPanel(threadId: string): void {
  let panel = document.getElementById('gi-thread-panel');
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = 'gi-thread-panel';
    panel.setAttribute('data-gi-ui', 'thread-panel');
    panel.style.cssText = [
      'position:fixed',
      'top:64px',
      'right:16px',
      'width:280px',
      'z-index:20',
      'background:#fff',
      'border:1px solid #dadce0',
      'border-radius:8px',
      'padding:12px',
    ].join(';');
    document.documentElement.append(panel);
  }
  void refreshPanel(panel, threadId);
}

function hideDomThreadPanel(): void {
  const panel = document.getElementById('gi-thread-panel');
  if (!panel) return;
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
  const res = (await chrome.runtime.sendMessage({ type: 'GET_THREAD_INTEL_MANY', threadIds })) as {
    intel?: Record<string, ThreadIntelData>;
  };
  const intel = res?.intel || {};
  for (const threadId of threadIds) {
    const category = intel[threadId]?.classification?.category;
    if (!category) continue;
    for (const row of rowsForThread(threadId)) applyCategoryChip(row, category, Boolean(intel[threadId]?.manual));
  }
}

async function refreshPanel(el: HTMLElement, threadId: string): Promise<void> {
  const intel = await getIntel(threadId);
  let root = panelRoots.get(el);
  if (!root) {
    root = createRoot(el);
    panelRoots.set(el, root);
  }
  root.render(
    createElement(ThreadIntelCard, {
      intel,
      pending: intel?.summary ? null : 'Reading this thread…',
      onDraft: () => void draftReply(threadId),
      onRemind: () => void remind(threadId),
    }),
  );
}

function getIntel(threadId: string): Promise<ThreadIntelData | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_THREAD_INTEL', threadId }, (intel?: ThreadIntelData) => {
      resolve(intel);
    });
  });
}

function createTracked(input: CreateTrackedEmailInput): Promise<CreateTrackedEmailResult | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CREATE_TRACKED_EMAIL', input }, (res) => {
      if (chrome.runtime.lastError || !res?.ok || !res.tracking_id || !res.pixel_url) {
        resolve(null);
        return;
      }
      resolve({
        tracking_id: res.tracking_id,
        pixel_url: res.pixel_url,
        rewritten_links: res.rewritten_links || [],
      });
    });
  });
}

function linkTracked(link: { trackingId: string; gmailThreadId: string | null; gmailMessageId: string | null }): void {
  chrome.runtime.sendMessage({ type: 'LINK_TRACKED_EMAIL', ...link });
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

async function insertDraft(threadId: string, text: string) {
  const opened = await adapter.actions.enqueueAndWait({ kind: 'CREATE_REPLY_DRAFT', threadId });
  if (!opened.success) {
    return { success: false, verified: false, action: 'CREATE_REPLY_DRAFT', threadId, reason: opened.reason || 'Could not open reply' };
  }
  await wait(700);
  await adapter.insertComposeBody(text);
  await wait(200);
  const compose = await adapter.getCurrentCompose();
  const thread = await adapter.getCurrentThread();
  const check = verifyDraftInserted({
    composeOpen: Boolean(compose.compose),
    bodyText: compose.compose?.bodyText || '',
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
  const wrap = document.createElement('div');
  wrap.setAttribute('data-gi-ui', 'cmdk');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(32,33,36,.32);display:flex;justify-content:center;padding-top:12vh';
  const panel = document.createElement('div');
  panel.style.cssText = 'width:min(480px,92vw);background:#fff;border-radius:8px;overflow:hidden;font:14px/1.4 "Google Sans",Roboto,Arial,sans-serif';
  const input = document.createElement('input');
  input.placeholder = 'Search commands';
  input.style.cssText = 'width:100%;border:0;border-bottom:1px solid #dadce0;padding:12px 14px;outline:none;font:inherit';
  const list = document.createElement('div');
  const render = (filter: string) => {
    list.replaceChildren();
    for (const command of VISIBLE_COMMANDS.filter((item) => item.label.toLowerCase().includes(filter.toLowerCase()))) {
      const row = document.createElement('button');
      row.type = 'button';
      row.textContent = command.label;
      row.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 14px;border:0;background:#fff;cursor:pointer;font:inherit';
      row.onclick = () => {
        wrap.remove();
        void runCommand(command.id);
      };
      list.append(row);
    }
  };
  render('');
  input.oninput = () => render(input.value);
  wrap.onclick = (event) => {
    if (event.target === wrap) wrap.remove();
  };
  panel.append(input, list);
  wrap.append(panel);
  document.documentElement.append(wrap);
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
    const res = await send<{ ok?: boolean; oneLine?: string; reason?: string }>({ type: 'SUMMARIZE_THREAD', threadId });
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
  const res = await send<{ ok?: boolean; body?: string; reason?: string }>({ type: 'DRAFT_REPLY', threadId });
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

function send<T>(message: unknown): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response as T));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
else void boot();
