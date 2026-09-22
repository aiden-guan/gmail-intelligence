import { AgentLoop } from '@gi/agent';
import {
  AIJobQueue,
  CHATGPT_DEFAULT_MODEL,
  ChatGptHttpError,
  createAIProvider,
  createPromptBackedProvider,
  isChatGptModel,
  requestChatGptText,
} from '@gi/ai';
import { WorkerTabController } from '@gi/gmail';
import { getMailboxDb, MailboxIngestor, IndexJobRunner } from '@gi/mailbox';
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
  getChatGptAccess,
  getChatGptPublicStatus,
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
  return settings;
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
  const attempt = async () => {
    const access = await getChatGptAccess();
    return requestChatGptText({
      accessToken: access.accessToken,
      accountId: access.accountId,
      model,
      instructions: system,
      input: user,
    });
  };
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
      // Ask content script / worker tab to archive via Gmail UI
      const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
      const tab = tabs[0];
      if (!tab?.id) return { success: false, error: 'no gmail tab' };
      try {
        const res = (await chrome.tabs.sendMessage(tab.id, {
          type: 'PERFORM_ACTION',
          action: { kind: 'ARCHIVE_THREAD', threadId },
        })) as { success?: boolean; error?: string };
        return { success: Boolean(res?.success), error: res?.error };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },
    insertDraftViaGmail: async (threadId, body) => {
      const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
      const tab = tabs[0];
      if (!tab?.id) return { success: false, localOnly: true, error: 'no gmail tab' };
      try {
        const res = (await chrome.tabs.sendMessage(tab.id, {
          type: 'PERFORM_ACTION',
          action: { kind: 'CREATE_REPLY_DRAFT', threadId },
          insertText: body,
        })) as { success?: boolean; error?: string };
        if (!res?.success) return { success: false, localOnly: true, error: res?.error };
        return { success: true };
      } catch (e) {
        return { success: false, localOnly: true, error: String(e) };
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

async function runDiagnostics() {
  const coverage = await ingestor.getCoverage();
  return {
    inboxSdk: 'check content script',
    gmailJsCapture: 'check content script',
    domAdapter: true,
    workerTab: workerTabs.getTabId() != null,
    indexedDb: true,
    aiProvider: settings.aiMode === 'disabled' ? 'disabled' : settings.aiProvider,
    chatgpt: await getChatGptPublicStatus(),
    trackingBackend: Boolean(settings.trackerBaseUrl && settings.personalApiToken),
    lastGmailEvent: null as string | null,
    lastClassifierRun: agent?.getLastClassifierRun() ?? null,
    coverage: formatCoverageWarning(coverage),
    usageToday: queue.usageToday,
  };
}

async function pollTracking(): Promise<void> {
  if (!settings.trackingEnabled || !settings.trackerBaseUrl || !settings.personalApiToken) return;
  const client = new TrackingClient(settings.trackerBaseUrl, settings.personalApiToken);
  try {
    const remote = await client.listEmails(200);
    const local = await readTrackedEmails();
    const byId = new Map(local.map((email) => [email.trackingId, email]));
    for (const row of remote) {
      byId.set(row.tracking_id, summaryFromRemote(row, byId.get(row.tracking_id) || null));
    }
    await writeTrackedEmails([...byId.values()]);
  } catch (e) {
    console.warn('[gi] tracking list failed', e);
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
      chrome.notifications.create(ev.id, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: ev.type === 'OPEN' ? 'Open detected' : 'Link click detected',
        message:
          ev.type === 'OPEN'
            ? `${who} opened “${subject}”`
            : `${who} clicked a link in “${subject}”`,
      });
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
    await chrome.runtime.openOptionsPage();
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
        chrome.notifications.create(`rem_${r.id}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Follow-up reminder',
          message: r.reason,
        });
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'LOCAL_MODEL_PROGRESS' || message?.type === 'LOCAL_MODEL_RELEASE') return false;
  void (async () => {
    await loadSettings();
    if (!agent) rebuildAgent();

    const parsed = RuntimeMessageSchema.safeParse(message);
    if (!parsed.success) {
      // Allow internal content-script messages
      if (message?.type === 'INGEST_THREAD') {
        const result = await ingestor.ingestThread(message.thread);
        if (result.changed && agent) {
          const t = message.thread;
          const latest = t.messages?.[t.messages.length - 1];
          const direction = message.direction || 'inbound';
          if (direction === 'inbound') {
            await agent.resolveReminderOnInbound(t.threadId);
          }
          await agent.onNewMessage({
            threadId: t.threadId,
            fingerprint: result.fingerprint,
            subject: t.subject,
            snippet: t.snippet || '',
            bodyText: latest?.bodyText || t.snippet || '',
            latestSenderEmail: latest?.sender?.email || t.latestSender?.email || 'unknown',
            direction,
            messages: (t.messages || []).map((m: { sender: { email: string }; bodyText: string; timestamp: string }) => ({
              sender: m.sender.email,
              bodyText: m.bodyText,
              timestamp: m.timestamp,
            })),
          });
        }
        sendResponse({ ok: true, ...result });
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
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'FOCUS_SIDEPANEL') {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.windowId != null) {
            await chrome.sidePanel.open({ windowId: tab.windowId });
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }
      if (message?.type === 'OPEN_SPLIT') {
        await chrome.storage.session.set({ splitCategory: message.category || null });
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.windowId != null) {
            await chrome.sidePanel.open({ windowId: tab.windowId });
          }
        } catch {
          /* side panel may need user gesture */
        }
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'COMMAND') {
        const id = String(message.id || '');
        if (id === 'ask' || id === 'summarize') {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.windowId != null) {
            await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
          }
        }
        sendResponse({ ok: true, id });
        return;
      }
      if (message?.type === 'GET_THREAD_INTEL') {
        const threadId = message.threadId as string;
        const classification = await db.thread_classifications.get(threadId);
        const summary = await db.thread_summaries.get(threadId);
        const draft = await db.draft_suggestions.where('threadId').equals(threadId).first();
        sendResponse({ classification, summary, draft });
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
        indexRunner = new IndexJobRunner(ingestor, async (query, cursor) => {
          const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
          const tab = tabs[0];
          if (!tab?.id) return { threads: [], error: 'Open Gmail to index' };
          try {
            const res = (await chrome.tabs.sendMessage(tab.id, {
              type: 'INDEX_FETCH_BATCH',
              query,
              cursor,
            })) as {
              threads?: unknown[];
              nextCursor?: string;
              error?: string;
              captchaOrBlock?: boolean;
            };
            return {
              threads: (res.threads || []) as import('@gi/mailbox').IngestThread[],
              nextCursor: res.nextCursor,
              error: res.error,
              captchaOrBlock: res.captchaOrBlock,
            };
          } catch (e) {
            return { threads: [], error: String(e) };
          }
        });
        const cp = await indexRunner.run({
          mode: msg.mode,
          customQuery: msg.customQuery,
        });
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
          // Best-effort: open thread in All Mail via Gmail UI search (not a Gmail API call)
          const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
          if (tabs[0]?.id) {
            await chrome.tabs
              .sendMessage(tabs[0].id, {
                type: 'PERFORM_ACTION',
                action: {
                  kind: 'NAVIGATE_SEARCH',
                  query: `in:anywhere`,
                },
                thenOpenThreadId: action.threadId,
              })
              .catch(() => undefined);
          }
          await db.threads.update(action.threadId, { archivedLocally: false });
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
        const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
        if (!tabs[0]?.id) {
          sendResponse({ error: 'no gmail tab' });
          break;
        }
        const res = await chrome.tabs.sendMessage(tabs[0].id, {
          type: 'PERFORM_ACTION',
          action: { kind: msg.action, ...(msg.args || {}) },
        });
        sendResponse(res);
        break;
      }
      default:
        sendResponse({ error: 'unhandled' });
    }
  })();
  return true;
});

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
