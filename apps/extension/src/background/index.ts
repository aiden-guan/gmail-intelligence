import { AgentLoop } from '@gi/agent';
import {
  AIJobQueue,
  CHATGPT_DEFAULT_MODEL,
  ChatGptHttpError,
  createAIProvider,
  createPromptBackedProvider,
  isChatGptModel,
} from '@gi/ai';
import { selectGmailTab, WorkerTabController } from '@gi/gmail';
import { filterSplitThreads, getMailboxDb, IndexJobRunner, MailboxIngestor, type IngestThread, type SplitView } from '@gi/mailbox';
import {
  AskInboxEngine,
  formatCoverageWarning,
  HybridRetriever,
  LexicalSearchIndex,
} from '@gi/search';
import {
  DEFAULT_SETTINGS,
  RuntimeMessageSchema,
  addBusinessDays,
  type ExtensionSettings,
} from '@gi/shared';
import {
  TrackingClient,
  formatSentTrackingBadge,
  summaryFromRemote,
  type TrackedEmailSummary,
} from '@gi/tracking';
import { patchTrackedEmail, readTrackedEmails, upsertTrackedEmail, writeTrackedEmails } from './tracked-mail';
import {
  forceRefreshChatGpt,
  getChatGptPublicStatus,
  sendChatGptConversation,
  installChatGptLoginListeners,
  logoutChatGpt,
  rememberChatGptError,
  setChatGptSignedInHandler,
  startChatGptLogin,
} from './chatgpt-login';
import { completeOnDevice, downloadOnDevice } from './on-device';

const db = getMailboxDb();
const queue = new AIJobQueue();
const ingestor = new MailboxIngestor(db);
const lexical = new LexicalSearchIndex();
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let agent: AgentLoop | null = null;
let indexRunner: IndexJobRunner | null = null;
const notifiedEventIds = new Set<string>();

const workerTabs = new WorkerTabController({
  query: (q) => chrome.tabs.query(q) as Promise<Array<{ id?: number; url?: string; pinned?: boolean }>>,
  create: (p) => chrome.tabs.create(p) as Promise<{ id?: number }>,
  update: (id, p) => chrome.tabs.update(id, p),
  get: (id) => chrome.tabs.get(id) as Promise<{ id?: number; url?: string }>,
});

async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<ExtensionSettings> | undefined) };
  await applyBundledTracker();
  return settings;
}

async function applyBundledTracker(): Promise<void> {
  if (settings.trackerBaseUrl.trim() && settings.personalApiToken.trim()) return;
  try {
    const response = await fetch(chrome.runtime.getURL('tracker-config.json'));
    if (!response.ok) return;
    const config = (await response.json()) as { trackerBaseUrl?: string; personalApiToken?: string };
    if (!config.trackerBaseUrl?.startsWith('https://') || !config.personalApiToken) return;
    await saveSettings({
      trackingEnabled: true,
      trackOpens: true,
      trackLinks: true,
      trackerBaseUrl: config.trackerBaseUrl.replace(/\/$/, ''),
      personalApiToken: config.personalApiToken,
    });
  } catch {
    /* No machine-local tracker config is bundled. */
  }
}

async function saveSettings(partial: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  settings = { ...settings, ...partial };
  await chrome.storage.local.set({ settings });
  rebuildAgent();
  return settings;
}

function getAI() {
  if (settings.aiMode === 'disabled') return null;
  if (settings.aiProvider === 'chatgpt') {
    const model = isChatGptModel(settings.aiModel) ? settings.aiModel : CHATGPT_DEFAULT_MODEL;
    return createPromptBackedProvider(
      'chatgpt',
      (system, user) => completeChatGpt(model, system, user),
      { maxUserChars: 48_000 },
    );
  }
  if (settings.aiProvider === 'local') {
    return createPromptBackedProvider(
      'local',
      (system, user) => completeOnDevice(settings.aiModel, system, user),
      { maxUserChars: 4_000 },
    );
  }
  if (settings.aiProvider === 'chrome') {
    return createPromptBackedProvider(
      'chrome',
      (system, user) => completeOnDevice('gemini-nano', system, user),
      { maxUserChars: 7_000 },
    );
  }
  if (!settings.aiApiKey && settings.aiProvider !== 'ollama') return null;
  return createAIProvider(settings.aiProvider, {
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
    endpoint: settings.aiEndpoint,
  });
}

async function completeChatGpt(model: string, system: string, user: string) {
  const attempt = () =>
    sendChatGptConversation({
      model,
      instructions: system,
      input: user,
    });
  try {
    const result = await attempt();
    await rememberChatGptError(null);
    return result;
  } catch (error) {
    if (error instanceof ChatGptHttpError && (error.status === 401 || error.status === 403)) {
      try {
        await forceRefreshChatGpt();
        const result = await attempt();
        await rememberChatGptError(null);
        return result;
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : 'ChatGPT request failed';
        await rememberChatGptError(message);
        throw retryError;
      }
    }
    const message = error instanceof Error ? error.message : 'ChatGPT request failed';
    await rememberChatGptError(message);
    throw error;
  }
}

function rebuildAgent(): void {
  agent = new AgentLoop({
    db,
    ai: getAI(),
    queue,
    settings: () => settings,
    archiveViaGmail: async (threadId) => {
      try {
        const res = (await workerTabs.runExclusive((tabId) =>
          sendToTab(tabId, {
            type: 'PERFORM_ACTION',
            context: 'background',
            action: { kind: 'ARCHIVE_THREAD', threadId },
          }),
        )) as { success?: boolean; verified?: boolean; error?: string; reason?: string };
        const verified = Boolean(res?.success && res.verified);
        return { success: verified, error: verified ? undefined : res?.reason || res?.error || 'Archive was not confirmed' };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
    insertDraftViaGmail: async (threadId, body) => {
      try {
        const res = (await workerTabs.runExclusive((tabId) =>
          sendToTab(tabId, {
            type: 'PERFORM_ACTION',
            context: 'background',
            action: { kind: 'CREATE_REPLY_DRAFT', threadId },
            insertText: body,
          }),
        )) as { success?: boolean; verified?: boolean; error?: string; reason?: string };
        if (!res?.success || res.verified === false) {
          return { success: false, localOnly: true, error: res?.reason || res?.error || 'Draft was not confirmed' };
        }
        return { success: true };
      } catch (error) {
        return { success: false, localOnly: true, error: String(error) };
      }
    },
    log: async (entry) => {
      const id = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.agent_actions.put({
        id,
        type: entry.type,
        threadId: entry.threadId,
        detail: entry.detail,
        undoable: entry.undoable ?? false,
        undone: false,
        tier: entry.tier,
        createdAt: Date.now(),
        expiresAt: entry.expiresAt,
      });
      return id;
    },
    onIntel: (threadId, kind) => {
      void publishIntel(threadId, kind);
    },
  });
}

async function rebuildSearchIndex(): Promise<void> {
  lexical.clear();
  const docs = await db.search_documents.toArray();
  for (const d of docs) {
    lexical.upsert({
      id: d.id,
      threadId: d.threadId,
      subject: d.subject,
      text: d.text,
      senders: d.senders,
      recipients: d.recipients,
      labels: d.labels,
      timestamp: d.timestamp,
      fingerprint: d.fingerprint,
      quality: d.quality,
    });
  }
}

async function handleAskInbox(query: string) {
  await rebuildSearchIndex();
  const coverage = await ingestor.getCoverage();
  const embeddings = await db.embeddings.toArray();
  const embRecords = embeddings.map((e) => {
    // embeddings table is by fingerprint; join loosely via search docs
    return {
      fingerprint: e.fingerprint,
      threadId: e.fingerprint.slice(0, 16),
      subject: '',
      vector: e.vector,
      timestamp: new Date(e.createdAt).toISOString(),
    };
  });
  // Prefer search_documents for thread mapping
  const docs = await db.search_documents.toArray();
  const byFp = new Map(docs.map((d) => [d.fingerprint, d]));
  const mapped = embeddings
    .map((e) => {
      const d = byFp.get(e.fingerprint);
      if (!d) return null;
      return {
        fingerprint: e.fingerprint,
        threadId: d.threadId,
        subject: d.subject,
        vector: e.vector,
        timestamp: d.timestamp,
      };
    })
    .filter(Boolean) as Array<{
    fingerprint: string;
    threadId: string;
    subject: string;
    vector: number[];
    timestamp: string;
  }>;

  const retriever = new HybridRetriever(lexical, mapped.length ? mapped : embRecords);
  const ai = getAI();
  const engine = new AskInboxEngine(
    retriever,
    async () => coverage,
    async ({ query: q, chunks, coverageNote }) => {
      if (!ai || settings.aiMode === 'disabled') {
        const lines = chunks.map((c) => `• ${c.subject} (${c.threadId})`).join('\n');
        return {
          answer: `Lexical matches (AI disabled):\n${lines}\n\n${coverageNote}`,
          citations: chunks.map((c) => ({ threadId: c.threadId, subject: c.subject })),
          incompleteIndex: coverage.state !== 'idle' || coverage.totalIndexedThreads === 0,
        };
      }
      const contextChunks = [];
      for (const c of chunks) {
        const doc = await db.search_documents.get(c.threadId);
        contextChunks.push({
          threadId: c.threadId,
          subject: c.subject,
          text: (doc?.text || '').slice(0, 2000),
        });
      }
      const { result } = await ai.answerMailboxQuery({
        query: q,
        contextChunks,
        coverageNote,
      });
      return result;
    },
  );
  return engine.ask(query);
}

type GmailRuntimeReport = {
  connected?: boolean;
  integration?: string;
  inboxSdk?: string;
  domFallback?: string;
  lastEvent?: { type: string; at: number } | null;
  currentThreadId?: string | null;
  lastAction?: { success: boolean; action: string; reason?: string; at: number } | null;
};

async function runDiagnostics() {
  const coverage = await ingestor.getCoverage();
  const stored = await chrome.storage.session.get('gmailRuntime');
  const runtime = (stored.gmailRuntime || null) as GmailRuntimeReport | null;
  let indexedThreads = 0;
  let mailboxDb: 'healthy' | 'error' = 'healthy';
  try {
    indexedThreads = await db.threads.count();
  } catch {
    mailboxDb = 'error';
  }
  let tracking: 'not_configured' | 'healthy' | 'unreachable' = 'not_configured';
  if (settings.trackerBaseUrl && settings.personalApiToken) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${settings.trackerBaseUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
      clearTimeout(timer);
      tracking = res.ok ? 'healthy' : 'unreachable';
    } catch {
      tracking = 'unreachable';
    }
  }
  const aiStatus = settings.aiMode === 'disabled' ? 'disabled' : getAI() ? 'ready' : 'error';
  let workerTab: 'ready' | 'inactive' | 'unavailable' = 'inactive';
  const workerId = workerTabs.getTabId();
  if (workerId != null) {
    try {
      const tab = await chrome.tabs.get(workerId);
      workerTab = tab.url?.includes('mail.google.com') ? 'ready' : 'unavailable';
    } catch {
      workerTab = 'unavailable';
    }
  }
  return {
    gmailTab: runtime?.connected ? 'connected' : 'unavailable',
    integration: runtime?.integration || 'unavailable',
    inboxSdk: runtime?.inboxSdk || 'failed',
    domFallback: runtime?.domFallback || 'unknown',
    lastGmailEvent: runtime?.lastEvent || null,
    mailboxDb,
    indexedThreads,
    currentThreadId: runtime?.currentThreadId || null,
    ai: { provider: settings.aiProvider, mode: settings.aiMode, status: aiStatus },
    tracking,
    workerTab,
    lastAction: runtime?.lastAction || null,
    lastClassifierRun: agent?.getLastClassifierRun() ?? null,
    coverage: formatCoverageWarning(coverage),
    usageToday: queue.usageToday,
  };
}

async function publishIntel(threadId: string, kind: string): Promise<void> {
  await chrome.storage.session.set({ intelPulse: { threadId, kind, at: Date.now() } });
  const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  await Promise.all(
    tabs.map((tab) =>
      tab.id == null
        ? undefined
        : chrome.tabs.sendMessage(tab.id, { type: 'THREAD_INTELLIGENCE_UPDATED', threadId, kind }).catch(() => undefined),
    ),
  );
}

async function sendToTab(tabId: number, message: unknown, attempts = 8): Promise<unknown> {
  let last = 'Gmail tab did not respond';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return { success: false, verified: false, reason: last };
}

async function openSidePanel(mode: 'inbox' | 'ask', splitCategory?: string): Promise<void> {
  const stored = await chrome.storage.session.get('panelState');
  const current = (stored.panelState || {}) as { mode?: string; splitCategory?: string };
  await chrome.storage.session.set({
    panelState: {
      mode,
      splitCategory: splitCategory || current.splitCategory || 'RESPOND',
    },
  });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
}

async function classifyIngested(thread: IngestThread, fingerprint: string, quality: IngestThread['quality'], direction: string): Promise<void> {
  if (!agent) return;
  const latest = thread.messages?.[thread.messages.length - 1];
  if (direction === 'inbound') await agent.resolveReminderOnInbound(thread.threadId);
  await agent.onNewMessage({
    threadId: thread.threadId,
    fingerprint,
    subject: thread.subject,
    snippet: thread.snippet || '',
    bodyText: latest?.bodyText || '',
    latestSenderEmail: latest?.sender?.email || thread.latestSender?.email || 'unknown',
    direction: direction === 'outbound' ? 'outbound' : 'inbound',
    quality: quality || 'ROW_STUB',
    messages: (thread.messages || []).map((message) => ({
      sender: message.sender.email,
      bodyText: message.bodyText,
      timestamp: message.timestamp || '',
    })),
  });
}

async function pollTracking(): Promise<void> {
  if (!settings.trackingEnabled || !settings.trackerBaseUrl || !settings.personalApiToken) return;
  const client = new TrackingClient(settings.trackerBaseUrl, settings.personalApiToken);
  const local = await readTrackedEmails();
  const byId = new Map(local.map((email) => [email.trackingId, email]));
  try {
    const remote = await client.listEmails(200);
    for (const row of remote) {
      byId.set(row.tracking_id, summaryFromRemote(row, byId.get(row.tracking_id) || null));
    }
    await writeTrackedEmails([...byId.values()]);
  } catch (e) {
    console.warn('[gi] tracking list failed', e);
    await Promise.all(
      local.slice(0, 40).map(async (email) => {
        try {
          const row = await client.getEmail(email.trackingId);
          byId.set(row.tracking_id, summaryFromRemote(row, email));
        } catch {
          /* keep the last status we already have */
        }
      }),
    );
    if (local.length) await writeTrackedEmails([...byId.values()]);
  }
  try {
    await loadNotifiedEvents();
    const events = await client.getRecentEvents();
    const local = await readTrackedEmails();
    for (const ev of events) {
      if (notifiedEventIds.has(ev.id)) continue;
      if (settings.hideSuspectedSelfOpens && ev.suspected_self_open) continue;
      if (!(await markEventNotified(ev.id))) continue;
      if (!settings.desktopNotifications) continue;
      const email = local.find((item) => item.trackingId === ev.tracking_id);
      const who = email?.recipients.length === 1 ? email.recipients[0] : 'Someone';
      const subject = email?.subject || 'your email';
      void Promise.resolve(chrome.notifications.create(ev.id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: ev.type === 'OPEN' ? 'Open detected' : 'Link click detected',
        message:
          ev.type === 'OPEN'
            ? `${who} opened “${subject}”`
            : `${who} clicked a link in “${subject}”`,
      })).catch(() => undefined);
    }
  } catch (e) {
    console.warn('[gi] tracking poll failed', e);
  }
}

async function loadNotifiedEvents(): Promise<void> {
  const stored = await chrome.storage.session.get('notifiedEventIds');
  const ids = stored.notifiedEventIds;
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (typeof id === 'string') notifiedEventIds.add(id);
  }
}

async function markEventNotified(id: string): Promise<boolean> {
  if (notifiedEventIds.has(id)) return false;
  notifiedEventIds.add(id);
  const ids = [...notifiedEventIds].slice(-200);
  await chrome.storage.session.set({ notifiedEventIds: ids });
  return true;
}

async function ensureNoReplyReminder(email: TrackedEmailSummary): Promise<void> {
  const due = addBusinessDays(new Date(), settings.reminderBusinessDays).getTime();
  await db.reminders.put({
    id: `trk_${email.trackingId}`,
    threadId: email.gmailThreadId || `pending:${email.trackingId}`,
    recipients: email.recipients,
    lastOutgoingAt: Date.parse(email.sentAt) || Date.now(),
    dueAt: due,
    status: 'pending',
    reason: `No reply yet from ${email.recipients[0] || 'recipient'}`,
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();
  rebuildAgent();
  if (details.reason === 'install') {
    const stored = await chrome.storage.local.get('onboardingComplete');
    if (!stored.onboardingComplete) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
  }
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  chrome.alarms.create('tracking_poll', { periodInMinutes: 0.5 });
  chrome.alarms.create('reminder_tick', { periodInMinutes: 15 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await loadSettings();
  if (alarm.name === 'tracking_poll') await pollTracking();
  if (alarm.name === 'reminder_tick') {
    const due = await db.reminders.where('status').equals('pending').toArray();
    const now = Date.now();
    for (const r of due) {
      if (r.dueAt <= now) {
        await db.reminders.update(r.id, { status: 'fired' });
        void Promise.resolve(chrome.notifications.create(`rem_${r.id}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'Follow-up reminder',
          message: r.reason,
        })).catch(() => undefined);
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'LOCAL_MODEL_PROGRESS' || message?.type === 'LOCAL_MODEL_RELEASE') return false;
  void (async () => {
    try {
    await loadSettings();
    if (!agent) rebuildAgent();

    const parsed = RuntimeMessageSchema.safeParse(message);
    if (!parsed.success) {
      // Allow internal content-script messages
      if (message?.type === 'INGEST_THREAD' || message?.type === 'INGEST_THREADS') {
        const threads = (message.type === 'INGEST_THREADS' ? message.threads : [message.thread]) as IngestThread[];
        const direction = message.direction || 'inbound';
        const results = [];
        for (const thread of threads || []) {
          if (!thread?.threadId) continue;
          const result = await ingestor.ingestThread(thread);
          results.push(result);
          if (result.changed) await classifyIngested(thread, result.fingerprint, result.quality, direction);
        }
        sendResponse({ ok: true, results });
        return;
      }
      if (message?.type === 'REPORT_RUNTIME') {
        await chrome.storage.session.set({ gmailRuntime: message.runtime });
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'LIST_SPLIT') {
        const category = String(message.category || 'RESPOND') as SplitView;
        const threads = await db.threads.toArray();
        const followUps =
          category === 'FOLLOW_UPS'
            ? (await db.reminders.where('status').equals('pending').toArray()).map((row) => row.threadId)
            : [];
        const matched = filterSplitThreads(threads, category, followUps);
        const rows = [];
        for (const thread of matched) {
          const summary = await db.thread_summaries.get(thread.threadId);
          rows.push({
            threadId: thread.threadId,
            subject: thread.subject,
            sender: thread.latestSender?.name || thread.latestSender?.email || 'Unknown',
            snippet: summary?.summary.oneLine || thread.snippet,
            timestamp: thread.latestTimestamp,
            priority: thread.priority,
            manual: Boolean(thread.manualCategory),
            category: thread.classification,
          });
        }
        rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
        sendResponse({ threads: rows, count: rows.length });
        return;
      }
      if (message?.type === 'SET_CATEGORY') {
        const threadId = String(message.threadId || '');
        const category = String(message.category || '');
        if (!threadId || !['RESPOND', 'WAITING', 'FYI'].includes(category)) {
          sendResponse({ ok: false, reason: 'Choose Respond, Waiting, or FYI.' });
          return;
        }
        await db.thread_overrides.put({
          threadId,
          category: category as 'RESPOND' | 'WAITING' | 'FYI',
          createdAt: Date.now(),
        });
        const thread = await db.threads.get(threadId);
        await db.thread_classifications.put({
          threadId,
          category: category as 'RESPOND' | 'WAITING' | 'FYI',
          confidence: 1,
          priority: thread?.priority || 'NORMAL',
          needsReply: category === 'RESPOND',
          waitingOnReply: category === 'WAITING',
          archiveRecommendation: false,
          reason: 'You set this category',
          source: 'override',
          fingerprint: thread?.contentFingerprint || 'manual',
          createdAt: Date.now(),
        });
        if (thread) {
          await db.threads.update(threadId, {
            classification: category as 'RESPOND' | 'WAITING' | 'FYI',
            manualCategory: category as 'RESPOND' | 'WAITING' | 'FYI',
            requiresResponse: category === 'RESPOND',
            awaitingResponse: category === 'WAITING',
            virtualLabels: [category],
          });
        }
        await publishIntel(threadId, 'THREAD_CLASSIFIED');
        sendResponse({ ok: true, category });
        return;
      }
      if (message?.type === 'SUMMARIZE_THREAD' || message?.type === 'DRAFT_REPLY') {
        const threadId = String(message.threadId || '');
        const thread = threadId ? await db.threads.get(threadId) : null;
        const stored = threadId ? await db.messages.where('threadId').equals(threadId).toArray() : [];
        const pageMessages = pageMessagesFrom(message.messages);
        const storedMessages = stored.map((row) => ({
          sender: row.sender.email,
          bodyText: row.bodyText,
          timestamp: row.timestamp,
        }));
        const messages = longerMessages(storedMessages, pageMessages);
        if ((!thread && !messages.length) || !agent) {
          sendResponse({ ok: false, reason: 'Open the thread first.' });
          return;
        }
        const input = {
          threadId,
          fingerprint: thread?.contentFingerprint || `page:${threadId}`,
          subject: thread?.subject || String(message.subject || ''),
          messages,
        };
        const result = message.type === 'SUMMARIZE_THREAD' ? await agent.requestSummary(input) : await agent.requestDraft(input);
        sendResponse(result);
        return;
      }
      if (message?.type === 'OUTGOING_COMPOSE') {
        await agent?.onOutgoing({
          threadId: message.threadId || 'unknown',
          recipients: message.recipients || [],
          subject: message.subject || '',
          bodyText: message.bodyText || '',
          fingerprint: message.fingerprint || '',
        });
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'CREATE_TRACKED_EMAIL') {
        // Token stays in service worker — never sent to content/MAIN world
        if (!settings.trackingEnabled || !settings.trackerBaseUrl || !settings.personalApiToken) {
          sendResponse({ error: 'tracking_not_configured' });
          return;
        }
        try {
          const client = new TrackingClient(settings.trackerBaseUrl, settings.personalApiToken);
          const created = await client.createEmail(message.input);
          const input = message.input as {
            subject?: string;
            sender?: string;
            recipients?: string[];
            gmail_thread_id?: string;
            gmail_message_id?: string;
          };
          await upsertTrackedEmail(
            summaryFromRemote(
              {
                tracking_id: created.tracking_id,
                subject: input.subject || '',
                sender: input.sender || '',
                recipients: input.recipients || [],
                gmail_thread_id: input.gmail_thread_id ?? null,
                gmail_message_id: input.gmail_message_id ?? null,
                sent_at: new Date().toISOString(),
                open_count: 0,
                click_count: 0,
              },
              null,
            ),
          );
          sendResponse({ ok: true, ...created });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
        return;
      }
      if (message?.type === 'LINK_TRACKED_EMAIL') {
        const trackingId = String(message.trackingId || '');
        const gmailThreadId = message.gmailThreadId ? String(message.gmailThreadId) : null;
        const gmailMessageId = message.gmailMessageId ? String(message.gmailMessageId) : null;
        if (!trackingId) {
          sendResponse({ error: 'missing_tracking_id' });
          return;
        }
        const patch: Partial<TrackedEmailSummary> = {};
        if (gmailThreadId) patch.gmailThreadId = gmailThreadId;
        if (gmailMessageId) patch.gmailMessageId = gmailMessageId;
        const updated = Object.keys(patch).length ? await patchTrackedEmail(trackingId, patch) : null;
        if (updated?.notifyIfNoReply) await ensureNoReplyReminder(updated);
        if (settings.trackerBaseUrl && settings.personalApiToken && (gmailThreadId || gmailMessageId)) {
          try {
            const client = new TrackingClient(settings.trackerBaseUrl, settings.personalApiToken);
            await client.linkEmail(trackingId, {
              ...(gmailThreadId ? { gmail_thread_id: gmailThreadId } : {}),
              ...(gmailMessageId ? { gmail_message_id: gmailMessageId } : {}),
            });
          } catch (e) {
            console.warn('[gi] tracking link failed', e);
          }
        }
        sendResponse({ ok: true, emails: await readTrackedEmails() });
        return;
      }
      if (message?.type === 'GET_TRACKED_EMAILS') {
        sendResponse({ emails: await readTrackedEmails() });
        return;
      }
      if (message?.type === 'SET_NO_REPLY_NOTIFY') {
        const trackingId = String(message.trackingId || '');
        const enabled = Boolean(message.enabled);
        const updated = await patchTrackedEmail(trackingId, { notifyIfNoReply: enabled });
        if (!updated) {
          sendResponse({ ok: false, emails: await readTrackedEmails() });
          return;
        }
        if (enabled) await ensureNoReplyReminder(updated);
        else await db.reminders.delete(`trk_${trackingId}`);
        sendResponse({ ok: true, emails: await readTrackedEmails() });
        return;
      }
      if (message?.type === 'REMIND_THREAD') {
        const threadId = String(message.threadId || '');
        if (!threadId) {
          sendResponse({ error: 'missing_thread' });
          return;
        }
        const due = addBusinessDays(new Date(), settings.reminderBusinessDays).getTime();
        await db.reminders.put({
          id: `rem_${threadId}`,
          threadId,
          recipients: [],
          lastOutgoingAt: Date.now(),
          dueAt: due,
          status: 'pending',
          reason: 'Manual remind',
        });
        sendResponse({ ok: true, dueAt: due });
        return;
      }
      if (message?.type === 'FOCUS_SIDEPANEL') {
        try {
          await openSidePanel(message.mode === 'inbox' ? 'inbox' : 'ask', message.category);
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({ ok: false, reason: String(error) });
        }
        return;
      }
      if (message?.type === 'OPEN_SPLIT') {
        try {
          await openSidePanel('inbox', String(message.category || 'RESPOND'));
          sendResponse({ ok: true, category: message.category });
        } catch (error) {
          sendResponse({ ok: false, reason: String(error) });
        }
        return;
      }
      if (message?.type === 'COMMAND') {
        const id = String(message.id || '');
        const known = ['ask', 'summarize', 'draft', 'remind', 'archive', 'settings', 'mark_respond', 'mark_waiting', 'mark_fyi'];
        if (!known.includes(id)) {
          sendResponse({ ok: false, reason: 'That command is not available.' });
          return;
        }
        sendResponse({ ok: false, reason: 'Run this command from Gmail.' });
        return;
      }
      if (message?.type === 'GET_THREAD_INTEL' || message?.type === 'GET_THREAD_INTEL_MANY') {
        const ids = (message.type === 'GET_THREAD_INTEL_MANY' ? message.threadIds : [message.threadId]) as string[];
        const intel: Record<string, unknown> = {};
        for (const threadId of (ids || []).filter((id) => typeof id === 'string').slice(0, 40)) {
          const [classification, summary, draft, override] = await Promise.all([
            db.thread_classifications.get(threadId),
            db.thread_summaries.get(threadId),
            db.draft_suggestions.where('threadId').equals(threadId).first(),
            db.thread_overrides.get(threadId),
          ]);
          intel[threadId] = { classification, summary, draft, manual: Boolean(override) };
        }
        sendResponse(message.type === 'GET_THREAD_INTEL_MANY' ? { intel } : intel[ids[0]] || {});
        return;
      }
      if (message?.type === 'ENSURE_WORKER_TAB') {
        const id = await workerTabs.ensureTab({ pinned: Boolean(message.pinned), active: false });
        sendResponse({ tabId: id });
        return;
      }
      if (message?.type === 'ENSURE_INBOXSDK_PAGEWORLD') {
        try {
          const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
          for (const tab of tabs) {
            if (tab.id == null) continue;
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'MAIN',
              files: ['inboxsdk/pageWorld.js'],
            });
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }
      if (message?.type === 'SAVE_AGENT_RULES') {
        const { parseNaturalLanguageRule } = await import('@gi/agent');
        const lines = (message.lines || []) as string[];
        await db.agent_rules.clear();
        for (const line of lines) {
          const structured = parseNaturalLanguageRule(line);
          if (!structured) continue;
          await db.agent_rules.put({
            id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            naturalLanguage: line,
            structured,
            enabled: true,
            createdAt: Date.now(),
          });
        }
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ error: 'invalid_message' });
      return;
    }

    const msg = parsed.data;
    switch (msg.type) {
      case 'PING':
        sendResponse({ ok: true });
        break;
      case 'GET_SETTINGS':
        sendResponse({ settings });
        break;
      case 'SAVE_SETTINGS':
        sendResponse({ settings: await saveSettings(msg.settings as Partial<ExtensionSettings>) });
        break;
      case 'RUN_DIAGNOSTICS':
        sendResponse(await runDiagnostics());
        break;
      case 'ASK_INBOX':
        sendResponse(await handleAskInbox(msg.query));
        break;
      case 'INDEX_INBOX': {
        const workerId = await workerTabs.ensureTab({ active: false, pinned: true });
        indexRunner = new IndexJobRunner(ingestor, async (query, cursor) => {
          const res = (await sendToTab(workerId, {
            type: 'INDEX_FETCH_BATCH',
            query,
            cursor,
          })) as {
            threads?: IngestThread[];
            nextCursor?: string;
            error?: string;
            captchaOrBlock?: boolean;
          };
          return {
            threads: res.threads || [],
            nextCursor: res.nextCursor,
            error: res.error,
            captchaOrBlock: res.captchaOrBlock,
          };
        });
        const cp = await indexRunner.run({
          mode: msg.mode,
          customQuery: msg.customQuery,
        });
        for (const threadId of (cp.processedThreadIds || []).slice(0, 8)) {
          const row = await db.threads.get(threadId);
          if (row?.quality === 'THREAD_COMPLETE') continue;
          const hydrated = (await sendToTab(workerId, {
            type: 'HYDRATE_THREAD',
            threadId,
            restore: true,
          })) as { thread?: IngestThread };
          if (!hydrated.thread) continue;
          const result = await ingestor.ingestThread(hydrated.thread);
          if (result.changed) await classifyIngested(hydrated.thread, result.fingerprint, result.quality, 'inbound');
        }
        await rebuildSearchIndex();
        sendResponse({ checkpoint: cp });
        break;
      }
      case 'PAUSE_INDEX':
        indexRunner?.pause();
        sendResponse({ ok: true });
        break;
      case 'RESUME_INDEX':
        indexRunner?.resume();
        sendResponse({ ok: true });
        break;
      case 'CLEAR_INDEX':
        await ingestor.clearIndex();
        lexical.clear();
        sendResponse({ ok: true });
        break;
      case 'CLEAR_AI_CACHE':
        queue.clearCache();
        await db.model_cache.clear();
        sendResponse({ ok: true });
        break;
      case 'GET_ACTIVITY_LOG': {
        const actions = await db.agent_actions.orderBy('createdAt').reverse().limit(100).toArray();
        sendResponse({ actions });
        break;
      }
      case 'UNDO_ACTION': {
        const action = await db.agent_actions.get(msg.actionId);
        if (!action || !action.undoable || action.undone) {
          sendResponse({ ok: false });
          break;
        }
        if (action.type === 'archive' && action.threadId) {
          const threadId = action.threadId;
          await workerTabs.runExclusive((tabId) =>
            sendToTab(tabId, {
              type: 'PERFORM_ACTION',
              context: 'background',
              action: { kind: 'NAVIGATE_SEARCH', query: 'in:anywhere' },
              thenOpenThreadId: threadId,
            }),
          );
          await db.threads.update(threadId, { archivedLocally: false });
        }
        await db.agent_actions.update(msg.actionId, { undone: true });
        sendResponse({ ok: true });
        break;
      }
      case 'TRACKING_POLL':
        await pollTracking();
        sendResponse({ ok: true });
        break;
      case 'CHATGPT_LOGIN':
        sendResponse(await startChatGptLogin());
        break;
      case 'CHATGPT_LOGOUT':
        await logoutChatGpt();
        if (settings.aiProvider === 'chatgpt') await saveSettings({ aiMode: 'disabled' });
        sendResponse({ ok: true });
        break;
      case 'CHATGPT_STATUS':
        sendResponse(await getChatGptPublicStatus());
        break;
      case 'LOCAL_MODEL_DOWNLOAD':
        try {
          await downloadOnDevice(msg.modelId);
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Could not download the model.',
          });
        }
        break;
      case 'WRITE_WITH_AI': {
        const ai = getAI();
        if (!ai) {
          sendResponse({ error: 'AI disabled' });
          break;
        }
        const { result } = await ai.rewriteText({
          text: msg.text,
          mode: msg.mode as import('@gi/ai').RewriteInput['mode'],
          voice: settings.voiceProfile,
          context: msg.context,
        });
        sendResponse({ text: result });
        break;
      }
      case 'GMAIL_EVENT':
        sendResponse({ ok: true });
        break;
      case 'ENQUEUE_ACTION': {
        const background = Boolean((msg.args as { background?: boolean } | undefined)?.background);
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        const gmailTabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
        const workerTabId = background ? await workerTabs.ensureTab({ active: false, pinned: true }) : workerTabs.getTabId();
        const selected = selectGmailTab({
          mode: background ? 'background' : 'foreground',
          activeTab: active,
          workerTabId,
          gmailTabs,
        });
        if (selected.tabId == null) {
          sendResponse({ success: false, verified: false, reason: selected.reason || 'No Gmail tab' });
          break;
        }
        const res = await sendToTab(selected.tabId, {
          type: 'PERFORM_ACTION',
          context: background ? 'background' : 'foreground',
          action: { kind: msg.action, ...(msg.args || {}) },
        });
        sendResponse(res);
        break;
      }
      default:
        sendResponse({ error: 'unhandled' });
    }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The extension hit an error.';
      try {
        sendResponse({ ok: false, reason });
      } catch {
        /* The response was already sent. */
      }
    }
  })();
  return true;
});

function pageMessagesFrom(value: unknown): Array<{ sender: string; bodyText: string; timestamp: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { sender?: unknown; bodyText?: unknown; timestamp?: unknown };
    const bodyText = typeof row.bodyText === 'string' ? row.bodyText.slice(0, 20_000) : '';
    if (!bodyText.trim()) return [];
    return [{
      sender: typeof row.sender === 'string' ? row.sender.slice(0, 200) : 'unknown',
      bodyText,
      timestamp: typeof row.timestamp === 'string' ? row.timestamp.slice(0, 80) : '',
    }];
  });
}

function longerMessages(
  stored: Array<{ sender: string; bodyText: string; timestamp: string }>,
  page: Array<{ sender: string; bodyText: string; timestamp: string }>,
): Array<{ sender: string; bodyText: string; timestamp: string }> {
  const length = (rows: Array<{ bodyText: string }>) => rows.reduce((sum, row) => sum + row.bodyText.trim().length, 0);
  if (length(page) > length(stored)) return page;
  return stored.length ? stored : page;
}

setChatGptSignedInHandler(async () => {
  const model = isChatGptModel(settings.aiModel) ? settings.aiModel : CHATGPT_DEFAULT_MODEL;
  await saveSettings({
    aiMode: 'remote',
    aiProvider: 'chatgpt',
    aiModel: model,
  });
});

installChatGptLoginListeners();

void loadSettings().then(async () => {
  rebuildAgent();
  chrome.alarms.create('tracking_poll', { periodInMinutes: 1 });
  await pollTracking();
});

export { formatSentTrackingBadge };
