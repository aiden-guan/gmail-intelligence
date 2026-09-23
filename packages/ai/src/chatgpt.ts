import type { UsageStats } from './index.js';

/**
 * ChatGPT plan sign-in.
 *
 * Uses the chatgpt.com session from the browser profile. Requests go to the
 * conversation endpoint that draws on the account's normal message allowance.
 * Inbox text is sent as a temporary chat.
 */

export const CHATGPT_SESSION_URL = 'https://chatgpt.com/api/auth/session';
export const CHATGPT_CONVERSATION_URL = 'https://chatgpt.com/backend-api/conversation';
export const CHATGPT_DEFAULT_MODEL = 'auto';
export const CHATGPT_MODELS = [
  { id: 'auto', label: 'Auto' },
  { id: 'gpt-5-5', label: 'GPT-5.5' },
] as const;

const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';
/** ChatGPT web refreshes a bearer once it is inside this window. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export type ChatGptSession = {
  accessToken: string;
  expiresAtMs: number;
  accountId: string;
  email: string | null;
  planType: string | null;
  source: 'chatgpt-web';
};

export type ChatGptIdentity = {
  accountId: string | null;
  email: string | null;
  planType: string | null;
  expiresAtMs: number | null;
};

export class ChatGptHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ChatGptHttpError';
    this.status = status;
    this.retryable = status === 429;
  }
}

export class ChatGptAuthError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'ChatGptAuthError';
    this.permanent = permanent;
  }
}

export function decodeChatGptIdentity(accessToken: string): ChatGptIdentity {
  const empty: ChatGptIdentity = {
    accountId: null,
    email: null,
    planType: null,
    expiresAtMs: null,
  };
  const part = accessToken.split('.')[1];
  if (!part) return empty;
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const auth = asRecord(payload[AUTH_CLAIM]);
    const profile = asRecord(payload[PROFILE_CLAIM]);
    const exp = payload.exp;
    const expSeconds = typeof exp === 'number' ? exp : typeof exp === 'string' ? Number(exp) : Number.NaN;
    return {
      accountId: asString(auth?.chatgpt_account_id),
      email: asString(profile?.email),
      planType: asString(auth?.chatgpt_plan_type),
      expiresAtMs: Number.isFinite(expSeconds) ? expSeconds * 1000 : null,
    };
  } catch {
    return empty;
  }
}

export function isChatGptSessionStale(expiresAtMs: number, now = Date.now()): boolean {
  return !Number.isFinite(expiresAtMs) || now >= expiresAtMs - TOKEN_REFRESH_SKEW_MS;
}

export function isChatGptModel(model: string): boolean {
  return CHATGPT_MODELS.some((entry) => entry.id === model);
}

export function sessionFromChatGptAuth(json: unknown, now = Date.now()): ChatGptSession | null {
  const record = asRecord(json);
  const accessToken = asString(record?.accessToken);
  if (!accessToken) return null;
  const user = asRecord(record?.user);
  const identity = decodeChatGptIdentity(accessToken);
  const expiresField = asString(record?.expires);
  const parsedExpires = expiresField ? Date.parse(expiresField) : Number.NaN;
  const sessionExpiresAtMs = Number.isFinite(parsedExpires) ? parsedExpires : null;
  const expiresAtMs = earlierExpiry(identity.expiresAtMs, sessionExpiresAtMs) ?? now + 10 * 60 * 1000;
  return {
    accessToken,
    expiresAtMs,
    accountId: identity.accountId ?? '',
    email: asString(user?.email) ?? identity.email,
    planType: identity.planType,
    source: 'chatgpt-web',
  };
}

export async function fetchChatGptWebSession(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<ChatGptSession | null> {
  let response: Response;
  try {
    response = await fetchImpl(CHATGPT_SESSION_URL, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return sessionFromChatGptAuth(await response.json(), now);
}

function earlierExpiry(tokenExp: number | null, sessionExp: number | null): number | null {
  if (tokenExp != null && sessionExp != null) return Math.min(tokenExp, sessionExp);
  return tokenExp ?? sessionExp;
}

export function buildChatGptConversationRequest(input: {
  accessToken: string;
  accountId: string;
  model: string;
  instructions: string;
  input: string;
}): { url: string; headers: Record<string, string>; body: string } {
  const body = buildChatGptConversationBody({
    model: input.model,
    instructions: input.instructions,
    input: input.input,
    messageId: crypto.randomUUID(),
    parentMessageId: crypto.randomUUID(),
  });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (input.accountId) headers['ChatGPT-Account-ID'] = input.accountId;
  return { url: CHATGPT_CONVERSATION_URL, headers, body: JSON.stringify(body) };
}

export function chatGptTextFromHttp(status: number, raw: string): { text: string; usage?: UsageStats } {
  if (status !== 200 && status !== 201) {
    throw new ChatGptHttpError(status, publicHttpError(status, raw));
  }
  return parseChatGptConversationSse(raw);
}

export function buildChatGptConversationBody(input: {
  model: string;
  instructions: string;
  input: string;
  messageId: string;
  parentMessageId: string;
  now?: Date;
}): Record<string, unknown> {
  const now = input.now ?? new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return {
    action: 'next',
    messages: [
      {
        id: input.messageId,
        author: { role: 'user' },
        content: {
          content_type: 'text',
          parts: [`${input.instructions}\n\n${input.input}`],
        },
      },
    ],
    parent_message_id: input.parentMessageId,
    model: isChatGptModel(input.model) ? input.model : CHATGPT_DEFAULT_MODEL,
    history_and_training_disabled: true,
    conversation_mode: { kind: 'primary_assistant' },
    force_paragen: false,
    force_rate_limit: false,
    timezone_offset_min: now.getTimezoneOffset(),
    timezone: timeZone,
  };
}

export async function requestChatGptText(
  input: {
    accessToken: string;
    accountId: string;
    model: string;
    instructions: string;
    input: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; usage?: UsageStats }> {
  const request = buildChatGptConversationRequest(input);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      credentials: 'include',
      headers: request.headers,
      body: request.body,
    });
  } catch {
    throw new ChatGptHttpError(0, 'Could not reach ChatGPT.');
  }

  if (!response.ok) {
    throw new ChatGptHttpError(response.status, publicHttpError(response.status, await response.text()));
  }

  const raw = await readBoundedBody(response);
  return parseChatGptConversationSse(raw);
}

export function parseChatGptConversationSse(raw: string): { text: string; usage?: UsageStats } {
  let text = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const error = asRecord(event.error);
    const errorMessage = asString(error?.message) || asString(event.detail);
    if (errorMessage) throw new ChatGptHttpError(502, clipPublic(errorMessage));

    const message = asRecord(event.message);
    const author = asRecord(message?.author);
    if (author?.role !== 'assistant') continue;
    const content = asRecord(message?.content);
    const parts = content?.parts;
    if (!Array.isArray(parts)) continue;
    const next = parts.filter((part): part is string => typeof part === 'string').join('');
    if (next.trim()) text = next;
  }

  const cleaned = text.trim();
  if (!cleaned) throw new ChatGptHttpError(502, 'ChatGPT returned an empty response.');
  return { text: cleaned };
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (raw.length > 2_000_000) {
      await reader.cancel();
      throw new ChatGptHttpError(502, 'ChatGPT response was too large.');
    }
  }
  raw += decoder.decode();
  return raw;
}

function publicHttpError(status: number, body: string): string {
  if (status === 429) return 'rate_limited';
  const detail = clipPublic(body);
  if (/sentinel|turnstile|proof of work|proof-token/i.test(detail)) {
    return 'ChatGPT could not verify this browser session. Open chatgpt.com, sign in, and try again.';
  }
  if (status === 401 || (status === 403 && /unauthorized|access token|expired/i.test(detail))) {
    return 'ChatGPT session expired. Sign in again.';
  }
  if (status === 403) {
    return detail
      ? `ChatGPT rejected the request: ${detail}`
      : 'ChatGPT rejected the request. Open chatgpt.com and try again.';
  }
  if (status === 404 || /model/i.test(detail)) {
    return 'That ChatGPT model is not available on this account. Pick another model in Settings.';
  }
  return detail ? `ChatGPT request failed (${status}): ${detail}` : `ChatGPT request failed (${status}).`;
}

function clipPublic(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
