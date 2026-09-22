import {
  BridgeMessageSchema,
  type ExtensionSettings,
  DEFAULT_SETTINGS,
} from '@gi/shared';
import {
  CompositeGmailAdapter,
  validateGmailJsBridgePayload,
  type QueuedGmailAction,
} from '@gi/gmail';
import type { InboxSdkLike } from '@gi/gmail';
import type { CreateTrackedEmailInput, CreateTrackedEmailResult, TrackedEmailSummary } from '@gi/tracking';
import { attachSdkComposeTracking, installDomComposeTracking } from './compose-tracking';
import { installSentStatus, type SentStatusController } from './sent-status';

const BRIDGE_SOURCE = 'gi-main-world';
const adapter = new CompositeGmailAdapter();
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let sdkReady = false;
let sdkOwnsCompose = false;
let sentStatus: SentStatusController | null = null;

async function refreshSettings(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })) as {
      settings?: ExtensionSettings;
    };
    if (res?.settings) settings = res.settings;
  } catch {
    /* ignore */
  }
}

function injectMainWorld(): void {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('main-world.js');
  s.async = false;
  (document.documentElement || document.head).appendChild(s);
  s.onload = () => s.remove();
}

async function loadInboxSdk(): Promise<void> {
  try {
    // Inject pageWorld for MV3
    await chrome.runtime.sendMessage({ type: 'ENSURE_INBOXSDK_PAGEWORLD' }).catch(() => undefined);
    const mod = await import('@inboxsdk/core');
    const InboxSDK = (mod as { InboxSDK?: { load: typeof mod.load }; load: typeof mod.load }).InboxSDK
      || mod;
    const appId = settings.inboxSdkAppId || 'gi-local-dev';
    const sdk = (await InboxSDK.load(2, appId, {
      appName: 'Gmail Intelligence',
    })) as unknown as InboxSdkLike;
    adapter.bindInboxSdk(sdk);
    sdkReady = true;
    setupSdkUi(sdk);
  } catch (err) {
    console.warn('[gi] InboxSDK unavailable, using DOM fallback', err);
    sdkReady = false;
  }
}

function setupSdkUi(sdk: InboxSdkLike): void {
  try {
    sdk.Lists.registerThreadRowViewHandler(async (rowView) => {
      const threadId =
        (typeof rowView.getThreadID === 'function' && rowView.getThreadID()) ||
        (typeof rowView.getThreadIDAsync === 'function'
          ? await rowView.getThreadIDAsync()
          : null);
      const rowElement = typeof rowView.getElement === 'function' ? rowView.getElement() : null;
      const threadRow =
        rowElement?.closest?.('tr.zA, tr[data-legacy-thread-id], div[role="listitem"]') || rowElement;
      if (threadRow && typeof threadId === 'string') {
        threadRow.setAttribute('data-gi-thread-id', threadId);
        sentStatus?.paint();
      }
      if (!threadId || typeof threadId !== 'string') return;
      chrome.runtime.sendMessage(
        { type: 'GET_THREAD_INTEL', threadId },
        (intel: { classification?: { category?: string } } | undefined) => {
          const cat = intel?.classification?.category;
          if (cat && rowView.addLabel) {
            const colors = categoryColors(cat);
            rowView.addLabel({
              title: cat,
              foregroundColor: colors.fg,
              backgroundColor: colors.bg,
            });
          }
        },
      );
    });
  } catch {
    /* degrade */
  }

  try {
    sdk.Conversations.registerThreadViewHandler((threadView) => {
      mountThreadSidebar(threadView);
    });
  } catch {
    /* degrade */
  }

  try {
    sdk.Compose.registerComposeViewHandler((composeView) => {
      addWriteWithAiButton(composeView);
      attachSdkComposeTracking(composeView, {
        getSettings: () => settings,
        refreshSettings,
        createTracked,
        linkTracked,
        onSent: ({ subject, recipients, bodyText }) => {
          chrome.runtime.sendMessage({
            type: 'OUTGOING_COMPOSE',
            subject,
            recipients,
            bodyText,
            threadId: 'sent',
          });
        },
      });
    });
    sdkOwnsCompose = true;
  } catch {
    /* degrade */
  }

  try {
    if (sdk.NavMenu?.addNavItem) {
      const splits = [
        'Priority',
        'Respond',
        'Waiting',
        'FYI',
        'Notifications',
        'Promotions',
        'News',
        'Follow-ups',
      ];
      for (const name of splits) {
        sdk.NavMenu.addNavItem({
          name,
          routeID: `gi/${name.toLowerCase()}`,
          onClick: () => {
            void openSplit(name);
          },
        });
      }
    }
  } catch {
    /* degrade */
  }
}

function categoryColors(cat: string): { fg: string; bg: string } {
  switch (cat) {
    case 'RESPOND':
      return { fg: '#8b1a1a', bg: '#fce8e6' };
    case 'WAITING':
      return { fg: '#8a6116', bg: '#fef7e0' };
    case 'FYI':
      return { fg: '#174ea6', bg: '#e8f0fe' };
    case 'NOTIFICATIONS':
      return { fg: '#3c4043', bg: '#f1f3f4' };
    case 'PROMOTIONS':
      return { fg: '#137333', bg: '#e6f4ea' };
    case 'NEWS':
      return { fg: '#5e35b1', bg: '#f3e8fd' };
    default:
      return { fg: '#3c4043', bg: '#f1f3f4' };
  }
}

async function openSplit(name: string): Promise<void> {
  const map: Record<string, string> = {
    Respond: 'RESPOND',
    Waiting: 'WAITING',
    FYI: 'FYI',
    Notifications: 'NOTIFICATIONS',
    Promotions: 'PROMOTIONS',
    News: 'NEWS',
    'Follow-ups': 'WAITING',
    Priority: 'RESPOND',
  };
  const category = map[name];
  // Navigate using Gmail search of locally known threads is imperfect;
  // open side panel filtered view as primary UX.
  chrome.runtime.sendMessage({ type: 'OPEN_SPLIT', category }).catch(() => undefined);
  await adapter.navigateToSearch(category === 'WAITING' ? 'is:sent' : 'in:inbox');
}

function mountThreadSidebar(threadView: {
  getThreadID?: () => string;
  addSidebarContentPanel?: (desc: unknown) => { remove?: () => void };
}): void {
  const threadId = threadView.getThreadID?.();
  if (!threadId || !threadView.addSidebarContentPanel) return;
  if (document.querySelector(`[data-gi-ui="thread-sidebar"][data-thread="${threadId}"]`)) {
    return; // prevent duplicate roots
  }
  const el = document.createElement('div');
  el.setAttribute('data-gi-ui', 'thread-sidebar');
  el.setAttribute('data-thread', threadId);
  el.style.cssText =
    'font:13px/1.4 "IBM Plex Sans",system-ui,sans-serif;padding:10px 12px;color:#202124;';
  el.innerHTML = `<div style="font-weight:600;margin-bottom:6px;">Thread intelligence</div><div class="gi-body">Loading…</div>`;
  try {
    threadView.addSidebarContentPanel({
      title: 'GI',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      el,
    });
  } catch {
    return;
  }
  chrome.runtime.sendMessage({ type: 'GET_THREAD_INTEL', threadId }, (intel) => {
    const body = el.querySelector('.gi-body');
    if (!body) return;
    const cat = intel?.classification?.category || '—';
    const summary = intel?.summary?.summary?.oneLine || 'No summary yet';
    const needs = intel?.classification?.needsReply ? 'Yes' : 'No';
    const draft = intel?.draft?.suggestion?.body
      ? intel.draft.suggestion.body.slice(0, 160) + '…'
      : 'None';
    body.innerHTML = `
      <div><strong>Category:</strong> ${escapeHtml(cat)}</div>
      <div style="margin-top:4px"><strong>Needs reply:</strong> ${needs}</div>
      <div style="margin-top:8px;color:#5f6368">${escapeHtml(summary)}</div>
      <div style="margin-top:8px"><strong>Suggested:</strong> ${escapeHtml(draft)}</div>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <button data-act="insert" style="padding:4px 8px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer">Insert Draft</button>
        <button data-act="remind" style="padding:4px 8px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer">Remind</button>
        <button data-act="archive" style="padding:4px 8px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer">Archive</button>
        <button data-act="ask" style="padding:4px 8px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer">Ask</button>
      </div>`;
    body.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-act');
        if (act === 'archive') {
          void adapter.actions.enqueueArchiveVerified(threadId, async () => {
            const rows = await adapter.getVisibleThreadMetadata();
            return Boolean(rows.rows?.some((r) => r.threadId === threadId));
          });
        }
        if (act === 'insert' && intel?.draft?.suggestion?.body) {
          void adapter.createReplyDraft(threadId).then(() =>
            adapter.insertComposeBody(intel.draft.suggestion.body),
          );
        }
        if (act === 'ask') {
          chrome.runtime.sendMessage({ type: 'ASK_ABOUT_THREAD', threadId });
          void chrome.sidePanel?.open?.({ windowId: undefined as unknown as number }).catch(() => undefined);
        }
        if (act === 'remind') {
          chrome.runtime.sendMessage({ type: 'REMIND_THREAD', threadId });
        }
      });
    });
  });
}

function addWriteWithAiButton(composeView: {
  addButton?: (desc: unknown) => void;
  getBodyElement?: () => HTMLElement | null;
  insertTextIntoBodyAtCursor?: (t: string) => void;
}): void {
  composeView.addButton?.({
    title: 'Write with AI',
    iconUrl: chrome.runtime.getURL('icons/icon16.png'),
    onClick: async () => {
      const body = composeView.getBodyElement?.()?.textContent || '';
      const res = (await chrome.runtime.sendMessage({
        type: 'WRITE_WITH_AI',
        mode: 'improve',
        text: body,
      })) as { text?: string; error?: string };
      if (res?.text) {
        // Recoverability: keep previous text in data attribute
        const el = composeView.getBodyElement?.();
        if (el) el.setAttribute('data-gi-prev', body);
        composeView.insertTextIntoBodyAtCursor?.(res.text);
      }
    },
  });
}

function createTracked(input: CreateTrackedEmailInput): Promise<CreateTrackedEmailResult | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CREATE_TRACKED_EMAIL', input }, (res) => {
      if (chrome.runtime.lastError || !res?.ok || !res.tracking_id || !res.pixel_url) {
        if (res?.error) console.warn('[gi] tracking create failed (send continues)', res.error);
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

function linkTracked(link: {
  trackingId: string;
  gmailThreadId: string | null;
  gmailMessageId: string | null;
}): void {
  chrome.runtime.sendMessage({
    type: 'LINK_TRACKED_EMAIL',
    trackingId: link.trackingId,
    gmailThreadId: link.gmailThreadId,
    gmailMessageId: link.gmailMessageId,
  });
}

function rememberTrackedList(emails: TrackedEmailSummary[]): void {
  sentStatus?.setEmails(emails);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// MAIN world → content script bridge (validate everything)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  const parsed = BridgeMessageSchema.safeParse(data);
  if (!parsed.success || parsed.data.source !== BRIDGE_SOURCE) return;

  if (parsed.data.type === 'gmailjs_capture') {
    const v = validateGmailJsBridgePayload(parsed.data.payload);
    if (v.ok) {
      adapter.gmailJs.markAvailable(true);
      adapter.gmailJs.ingestValidatedCapture(v.data);
    }
    return;
  }

  chrome.runtime.sendMessage({
    type: 'GMAIL_EVENT',
    event: parsed.data.type,
    payload: parsed.data.payload,
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === 'PERFORM_ACTION') {
      const action = message.action as QueuedGmailAction;
      // Archives use open → archive → verify gone; other actions wait for structured result
      const result =
        action.kind === 'ARCHIVE_THREAD'
          ? await adapter.actions.enqueueArchiveVerifiedAndWait(action.threadId, async () => {
              const rows = await adapter.getVisibleThreadMetadata();
              return Boolean(rows.rows?.some((r) => r.threadId === action.threadId));
            })
          : await adapter.actions.enqueueAndWait(action);
      if (message.insertText && action.kind === 'CREATE_REPLY_DRAFT' && result.success) {
        await new Promise((r) => setTimeout(r, 800));
        const inserted = await adapter.insertComposeBody(message.insertText);
        sendResponse({
          success: inserted.success,
          actionId: result.actionId,
          error: inserted.error,
          verified: result.verified,
        });
        return;
      }
      if (message.thenOpenThreadId && result.success) {
        await new Promise((r) => setTimeout(r, 600));
        const opened = await adapter.openThread(String(message.thenOpenThreadId));
        sendResponse({
          success: opened.success,
          actionId: result.actionId,
          error: opened.error,
        });
        return;
      }
      sendResponse({
        success: result.success,
        actionId: result.actionId,
        error: result.error,
        verified: result.verified,
      });
      return;
    }
    if (message?.type === 'INDEX_FETCH_BATCH') {
      const page = Number(message.cursor || '0') || 0;
      if (page === 0) {
        await adapter.navigateToSearch(message.query);
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        // Scroll list to coax Gmail into loading more results (DOM-only; no private RPC)
        const scrollRoot =
          document.querySelector('div.AO') ||
          document.querySelector('div[role="main"]') ||
          document.scrollingElement;
        if (scrollRoot) {
          const before = scrollRoot.scrollTop;
          scrollRoot.scrollTop = scrollRoot.scrollHeight;
          if (scrollRoot.scrollTop === before && scrollRoot instanceof HTMLElement) {
            scrollRoot.scrollBy?.(0, 2000);
          }
        }
        await new Promise((r) => setTimeout(r, 1200));
      }

      const rows = await adapter.getVisibleThreadMetadata();
      if (!rows.success) {
        sendResponse({ threads: [], error: rows.error, captchaOrBlock: false });
        return;
      }
      const threads = (rows.rows || []).map((r) => ({
        threadId: r.threadId,
        subject: r.subject,
        participants: r.participants,
        latestSender: r.latestSender,
        latestTimestamp: r.latestTimestamp || new Date().toISOString(),
        messageCount: 1,
        snippet: r.snippet,
        route: 'search' as const,
        messages: [
          {
            messageId: `${r.threadId}-visible`,
            threadId: r.threadId,
            sender: r.latestSender || { email: 'unknown@local' },
            recipients: [],
            cc: [],
            timestamp: r.latestTimestamp || new Date().toISOString(),
            bodyText: r.snippet,
            attachmentsMetadata: [],
          },
        ],
      }));

      // Cap pages; IndexJobRunner also stops when a page yields no new thread IDs
      const maxPages = 25;
      const nextCursor = page + 1 < maxPages && threads.length > 0 ? String(page + 1) : undefined;
      sendResponse({ threads, nextCursor });
      return;
    }
    if (message?.type === 'GET_CAPABILITIES') {
      sendResponse(await adapter.detectCapabilities());
      return;
    }
  })();
  return true;
});

function setupCommandPalette(): void {
  document.addEventListener(
    'keydown',
    (e) => {
      if (!settings.commandPaletteEnabled) return;
      const isMac = navigator.platform.includes('Mac');
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'k') return;
      if (!settings.commandPaletteOverrideGmail) {
        // Only intercept when focus is not in Gmail search / compose
        const t = e.target as HTMLElement | null;
        if (t?.closest?.('input, textarea, [contenteditable="true"], [role="textbox"]')) {
          return;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      openCommandPalette();
    },
    true,
  );
}

function openCommandPalette(): void {
  if (document.querySelector('[data-gi-ui="cmdk"]')) return;
  const wrap = document.createElement('div');
  wrap.setAttribute('data-gi-ui', 'cmdk');
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;background:rgba(32,33,36,.45);display:flex;align-items:flex-start;justify-content:center;padding-top:15vh';
  const panel = document.createElement('div');
  panel.style.cssText =
    'width:min(520px,92vw);background:#fff;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.28);overflow:hidden;font:14px/1.4 IBM Plex Sans,system-ui,sans-serif';
  const input = document.createElement('input');
  input.placeholder = 'Command…';
  input.style.cssText =
    'width:100%;border:0;border-bottom:1px solid #dadce0;padding:14px 16px;outline:none;font:inherit';
  const list = document.createElement('div');
  const commands = [
    { id: 'ask', label: 'Ask Inbox' },
    { id: 'summarize', label: 'Summarize Thread' },
    { id: 'draft', label: 'Draft Reply' },
    { id: 'followup', label: 'Draft Follow-up' },
    { id: 'archive', label: 'Archive' },
    { id: 'remind', label: 'Remind Me' },
    { id: 'mark_respond', label: 'Mark Respond' },
    { id: 'mark_waiting', label: 'Mark Waiting' },
    { id: 'mark_fyi', label: 'Mark FYI' },
    { id: 'always_archive', label: 'Always Archive Sender' },
    { id: 'never_archive', label: 'Never Archive Sender' },
    { id: 'index', label: 'Index Recent Mail' },
    { id: 'settings', label: 'Open Agent Settings' },
  ];
  function render(filter: string) {
    list.innerHTML = '';
    for (const c of commands.filter((x) => x.label.toLowerCase().includes(filter.toLowerCase()))) {
      const row = document.createElement('button');
      row.textContent = c.label;
      row.style.cssText =
        'display:block;width:100%;text-align:left;padding:10px 16px;border:0;background:#fff;cursor:pointer;font:inherit';
      row.onmouseenter = () => {
        row.style.background = '#f1f3f4';
      };
      row.onmouseleave = () => {
        row.style.background = '#fff';
      };
      row.onclick = () => {
        wrap.remove();
        runCommand(c.id);
      };
      list.appendChild(row);
    }
  }
  render('');
  input.oninput = () => render(input.value);
  wrap.onclick = (ev) => {
    if (ev.target === wrap) wrap.remove();
  };
  document.addEventListener(
    'keydown',
    function onEsc(ev) {
      if (ev.key === 'Escape') {
        wrap.remove();
        document.removeEventListener('keydown', onEsc, true);
      }
    },
    true,
  );
  panel.appendChild(input);
  panel.appendChild(list);
  wrap.appendChild(panel);
  document.documentElement.appendChild(wrap);
  input.focus();
}

function runCommand(id: string): void {
  switch (id) {
    case 'ask':
      void chrome.runtime.sendMessage({ type: 'FOCUS_SIDEPANEL' });
      break;
    case 'settings':
      chrome.runtime.openOptionsPage();
      break;
    case 'index':
      void chrome.runtime.sendMessage({ type: 'INDEX_INBOX', mode: '30d' });
      break;
    case 'archive':
      void adapter.getCurrentThread().then((t) => {
        if (t.thread?.threadId) {
          const threadId = t.thread.threadId;
          void adapter.actions.enqueueArchiveVerified(threadId, async () => {
            const rows = await adapter.getVisibleThreadMetadata();
            return Boolean(rows.rows?.some((r) => r.threadId === threadId));
          });
        }
      });
      break;
    default:
      void chrome.runtime.sendMessage({ type: 'COMMAND', id });
  }
}

async function boot(): Promise<void> {
  injectMainWorld();
  await refreshSettings();
  await adapter.start(async (event) => {
    if (event.type === 'thread_opened') {
      chrome.runtime.sendMessage({
        type: 'INGEST_THREAD',
        direction: 'inbound',
        thread: {
          threadId: event.thread.threadId,
          subject: event.thread.subject,
          participants: event.thread.messages.map((m) => m.sender),
          latestSender: event.thread.messages.at(-1)?.sender,
          latestTimestamp: event.thread.messages.at(-1)?.timestamp || new Date().toISOString(),
          messageCount: event.thread.messages.length,
          snippet: event.thread.messages.at(-1)?.bodyText?.slice(0, 200) || '',
          route: event.thread.route,
          messages: event.thread.messages,
        },
      });
    }
    if (event.type === 'inbox_observed') {
      for (const row of event.rows.slice(0, 25)) {
        chrome.runtime.sendMessage({
          type: 'INGEST_THREAD',
          direction: 'inbound',
          thread: {
            threadId: row.threadId,
            subject: row.subject,
            participants: row.participants,
            latestSender: row.latestSender,
            latestTimestamp: row.latestTimestamp || new Date().toISOString(),
            messageCount: 1,
            snippet: row.snippet,
            route: 'inbox',
            messages: [
              {
                messageId: `${row.threadId}-row`,
                threadId: row.threadId,
                sender: row.latestSender || { email: 'unknown@local' },
                recipients: [],
                cc: [],
                timestamp: row.latestTimestamp || new Date().toISOString(),
                bodyText: row.snippet,
                attachmentsMetadata: [],
              },
            ],
          },
        });
      }
    }
  });
  sentStatus = installSentStatus({
    trackerBaseUrl: settings.trackerBaseUrl,
    onNotify: (trackingId, enabled) => {
      chrome.runtime.sendMessage({ type: 'SET_NO_REPLY_NOTIFY', trackingId, enabled }, (res) => {
        if (Array.isArray(res?.emails)) rememberTrackedList(res.emails);
      });
    },
  });
  installDomComposeTracking({
    sdkOwnsCompose: () => sdkOwnsCompose,
    getSettings: () => settings,
    refreshSettings,
    createTracked,
    linkTracked,
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings?.newValue && typeof changes.settings.newValue === 'object') {
      settings = { ...settings, ...(changes.settings.newValue as ExtensionSettings) };
      sentStatus?.setTrackerBaseUrl(settings.trackerBaseUrl || '');
    }
    if (Array.isArray(changes.trackedEmails?.newValue)) {
      rememberTrackedList(changes.trackedEmails.newValue as TrackedEmailSummary[]);
    }
  });
  chrome.runtime.sendMessage({ type: 'GET_TRACKED_EMAILS' }, (res) => {
    if (Array.isArray(res?.emails)) rememberTrackedList(res.emails);
  });
  await loadInboxSdk();
  setupCommandPalette();
  console.info('[gi] content script ready', {
    sdkReady,
    caps: await adapter.detectCapabilities(),
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}
