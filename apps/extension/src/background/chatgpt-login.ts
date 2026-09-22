import {
  ChatGptAuthError,
  fetchChatGptWebSession,
  isChatGptSessionStale,
  sessionFromChatGptAuth,
  type ChatGptSession,
} from '@gi/ai';

const SESSION_KEY = 'chatgptSession';
const PENDING_KEY = 'chatgptPendingLogin';
const LAST_ERROR_KEY = 'chatgptLastError';
const LOGIN_URL = 'https://chatgpt.com/';
const LOGIN_TTL_MS = 10 * 60 * 1000;

type PendingLogin = {
  tabId: number;
  createdAt: number;
};

export type ChatGptPublicStatus = {
  signedIn: boolean;
  email: string | null;
  planType: string | null;
  lastError: string | null;
};

type LoginResult =
  | { ok: true; email: string | null; planType: string | null }
  | { ok: false; error: string };

type PageSession = {
  accessToken: string | null;
  expires: string | null;
  user: { email: string | null };
};

let refreshLock: Promise<ChatGptSession> | null = null;
let onSignedIn: ((session: { email: string | null; planType: string | null }) => Promise<void>) | null =
  null;

export function setChatGptSignedInHandler(
  handler: (session: { email: string | null; planType: string | null }) => Promise<void>,
): void {
  onSignedIn = handler;
}

export function installChatGptLoginListeners(): void {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return;
    void tryCompleteLogin(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void abandonIfPending(tabId);
  });
}

export async function getChatGptPublicStatus(): Promise<ChatGptPublicStatus> {
  const stored = await chrome.storage.local.get([SESSION_KEY, LAST_ERROR_KEY]);
  const session = asSession(stored[SESSION_KEY]);
  const lastError = typeof stored[LAST_ERROR_KEY] === 'string' ? stored[LAST_ERROR_KEY] : null;
  if (!session) {
    if (stored[SESSION_KEY]) await chrome.storage.local.remove(SESSION_KEY);
    return { signedIn: false, email: null, planType: null, lastError };
  }
  return {
    signedIn: true,
    email: session.email,
    planType: session.planType,
    lastError,
  };
}

export async function rememberChatGptError(message: string | null): Promise<void> {
  if (!message) {
    await chrome.storage.local.remove(LAST_ERROR_KEY);
    return;
  }
  await chrome.storage.local.set({ [LAST_ERROR_KEY]: message.slice(0, 300) });
}

export async function startChatGptLogin(): Promise<
  { ok: true; alreadySignedIn?: boolean; email?: string | null } | { ok: false; error: string }
> {
  const existing = await fetchChatGptWebSession().catch(() => null);
  if (existing) {
    await storeSession(existing);
    return { ok: true, alreadySignedIn: true, email: existing.email };
  }

  const previous = await readPending();
  if (previous) {
    await chrome.tabs.remove(previous.tabId).catch(() => undefined);
    await chrome.storage.session.remove(PENDING_KEY);
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (tab.id == null) return { ok: false, error: 'Could not open the ChatGPT sign-in tab.' };
  const pending: PendingLogin = { tabId: tab.id, createdAt: Date.now() };
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
  await chrome.tabs.update(tab.id, { url: LOGIN_URL });
  return { ok: true };
}

export async function logoutChatGpt(): Promise<void> {
  await chrome.storage.local.remove([SESSION_KEY, LAST_ERROR_KEY]);
  await clearPending();
}

export async function getChatGptAccess(): Promise<{ accessToken: string; accountId: string }> {
  const session = await readSession();
  if (!session) throw new Error('Sign in with ChatGPT in Settings.');
  if (!isChatGptSessionStale(session.expiresAtMs)) {
    return { accessToken: session.accessToken, accountId: session.accountId };
  }
  const next = await refreshSession();
  return { accessToken: next.accessToken, accountId: next.accountId };
}

export async function forceRefreshChatGpt(): Promise<void> {
  await refreshSession();
}

async function tryCompleteLogin(tabId: number): Promise<void> {
  const pending = await readPending();
  if (!pending || pending.tabId !== tabId) return;
  if (Date.now() - pending.createdAt > LOGIN_TTL_MS) {
    await clearPending();
    await broadcastLogin({ ok: false, error: 'ChatGPT sign-in expired. Try again.' });
    return;
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!tab.url?.startsWith('https://chatgpt.com/')) return;

  let payload: PageSession | null = null;
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readChatGptSessionInPage,
    });
    payload = injected?.result ?? null;
  } catch {
    return;
  }

  const session = sessionFromChatGptAuth(payload);
  if (!session) return;
  await clearPending();
  await storeSession(session);
  await chrome.tabs.remove(tabId).catch(() => undefined);
}

function readChatGptSessionInPage(): Promise<PageSession | null> {
  return fetch('/api/auth/session', { credentials: 'include' }).then(async (response) => {
    if (!response.ok) return null;
    const data = (await response.json()) as {
      accessToken?: unknown;
      expires?: unknown;
      user?: { email?: unknown };
    };
    return {
      accessToken: typeof data.accessToken === 'string' ? data.accessToken : null,
      expires: typeof data.expires === 'string' ? data.expires : null,
      user: { email: typeof data.user?.email === 'string' ? data.user.email : null },
    };
  });
}

async function storeSession(session: ChatGptSession): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  await chrome.storage.local.remove(LAST_ERROR_KEY);
  await onSignedIn?.({ email: session.email, planType: session.planType });
  await broadcastLogin({ ok: true, email: session.email, planType: session.planType });
}

async function refreshSession(): Promise<ChatGptSession> {
  if (!refreshLock) {
    refreshLock = (async () => {
      const current = await readSession();
      if (!current) throw new Error('Sign in with ChatGPT in Settings.');
      try {
        const next = await fetchChatGptWebSession();
        if (!next) {
          await chrome.storage.local.remove(SESSION_KEY);
          throw new ChatGptAuthError('ChatGPT sign-in expired. Sign in again.', true);
        }
        await chrome.storage.local.set({ [SESSION_KEY]: next });
        return next;
      } finally {
        refreshLock = null;
      }
    })();
  }
  return refreshLock;
}

async function abandonIfPending(tabId: number): Promise<void> {
  const pending = await readPending();
  if (!pending || pending.tabId !== tabId) return;
  await chrome.storage.session.remove(PENDING_KEY);
  await broadcastLogin({ ok: false, error: 'ChatGPT sign-in was canceled.' });
}

async function broadcastLogin(result: LoginResult): Promise<void> {
  await chrome.runtime
    .sendMessage({
      type: 'CHATGPT_LOGIN_FINISHED',
      ok: result.ok,
      email: result.ok ? result.email : undefined,
      planType: result.ok ? result.planType : undefined,
      error: result.ok ? undefined : result.error,
    })
    .catch(() => undefined);
}

async function readSession(): Promise<ChatGptSession | null> {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const session = asSession(stored[SESSION_KEY]);
  if (!session && stored[SESSION_KEY]) await chrome.storage.local.remove(SESSION_KEY);
  return session;
}

async function readPending(): Promise<PendingLogin | null> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] as PendingLogin | undefined;
  if (pending?.tabId == null || typeof pending.createdAt !== 'number') return null;
  return pending;
}

async function clearPending(): Promise<void> {
  await chrome.storage.session.remove(PENDING_KEY);
}

function asSession(value: unknown): ChatGptSession | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Partial<ChatGptSession>;
  if (session.source !== 'chatgpt-web' || !session.accessToken) return null;
  return {
    accessToken: session.accessToken,
    expiresAtMs: session.expiresAtMs ?? 0,
    accountId: session.accountId ?? '',
    email: session.email ?? null,
    planType: session.planType ?? null,
    source: 'chatgpt-web',
  };
}
