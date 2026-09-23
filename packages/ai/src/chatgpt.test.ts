import { describe, expect, it, vi } from 'vitest';
import {
  buildChatGptConversationBody,
  CHATGPT_CONVERSATION_URL,
  CHATGPT_SESSION_URL,
  decodeChatGptIdentity,
  fetchChatGptWebSession,
  isChatGptSessionStale,
  parseChatGptConversationSse,
  requestChatGptText,
  sessionFromChatGptAuth,
} from './chatgpt.js';
import { createPromptBackedProvider, extractJsonObject } from './prompt-provider.js';

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

describe('ChatGPT plan session', () => {
  it('reads account identity from the access token', () => {
    const identity = decodeChatGptIdentity(
      fakeJwt({
        exp: 1_800_000_000,
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_123',
          chatgpt_plan_type: 'plus',
        },
        'https://api.openai.com/profile': { email: 'me@example.com' },
      }),
    );
    expect(identity).toMatchObject({
      accountId: 'acct_123',
      email: 'me@example.com',
      planType: 'plus',
      expiresAtMs: 1_800_000_000_000,
    });
  });

  it('builds a plan session from the chatgpt.com session payload', () => {
    const access = fakeJwt({
      exp: 1_800_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123', chatgpt_plan_type: 'plus' },
      'https://api.openai.com/profile': { email: 'me@example.com' },
    });
    const session = sessionFromChatGptAuth({
      accessToken: access,
      expires: '2030-01-01T00:00:00.000Z',
      user: { email: 'me@example.com' },
    });
    expect(session).toMatchObject({
      accessToken: access,
      accountId: 'acct_123',
      email: 'me@example.com',
      planType: 'plus',
      source: 'chatgpt-web',
      expiresAtMs: 1_800_000_000_000,
    });
    expect(session).not.toHaveProperty('refreshToken');
  });

  it('ignores a session payload without an access token', () => {
    expect(sessionFromChatGptAuth({})).toBeNull();
    expect(isChatGptSessionStale(Date.now() + 10 * 60 * 1000)).toBe(false);
    expect(isChatGptSessionStale(Date.now() + 4 * 60 * 1000)).toBe(true);
    expect(isChatGptSessionStale(Date.now())).toBe(true);
  });

  it('treats the sooner of the token and the session clock as the deadline', () => {
    const access = fakeJwt({
      exp: 1_800_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123', chatgpt_plan_type: 'plus' },
    });
    const session = sessionFromChatGptAuth({
      accessToken: access,
      expires: '2026-01-01T00:00:00.000Z',
    });
    expect(session?.expiresAtMs).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('loads the session from chatgpt.com', async () => {
    const access = fakeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123', chatgpt_plan_type: 'pro' },
    });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ accessToken: access, user: { email: 'me@example.com' } }), { status: 200 }),
    );
    const session = await fetchChatGptWebSession(fetchImpl as typeof fetch);
    expect(session?.email).toBe('me@example.com');
    expect(session?.source).toBe('chatgpt-web');
    expect(fetchImpl).toHaveBeenCalledWith(CHATGPT_SESSION_URL, expect.any(Object));
  });
});

describe('ChatGPT plan conversation', () => {
  it('asks for a temporary chat on the plan conversation endpoint', () => {
    const body = buildChatGptConversationBody({
      model: 'gpt-5.6-sol',
      instructions: 'Be brief.',
      input: 'Hello',
      messageId: 'msg',
      parentMessageId: 'parent',
      now: new Date('2026-09-22T12:00:00Z'),
    });
    expect(body.model).toBe('auto');
    expect(body.history_and_training_disabled).toBe(true);
    expect(body.action).toBe('next');
    expect(JSON.stringify(body)).not.toMatch(/codex/i);
    expect(CHATGPT_CONVERSATION_URL).toBe('https://chatgpt.com/backend-api/conversation');
    expect(CHATGPT_CONVERSATION_URL).not.toMatch(/codex/);
  });

  it('keeps the latest assistant text from the conversation stream', () => {
    const raw = [
      'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["{\\"category\\":"]}}}',
      '',
      'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["{\\"category\\":\\"FYI\\"}"]}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    expect(parseChatGptConversationSse(raw).text).toBe('{"category":"FYI"}');
  });

  it('sends the plan conversation request without a Codex client marker', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["ok"]}}}\n',
        { status: 200 },
      ),
    );
    const result = await requestChatGptText(
      {
        accessToken: 'access',
        accountId: 'acct_123',
        model: 'auto',
        instructions: 'Be brief.',
        input: 'Hello',
      },
      fetchImpl as typeof fetch,
    );
    expect(result.text).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledWith(CHATGPT_CONVERSATION_URL, expect.any(Object));
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body)) as { model: string; history_and_training_disabled: boolean };
    expect(headers.Authorization).toBe('Bearer access');
    expect(headers['ChatGPT-Account-ID']).toBe('acct_123');
    expect(headers.originator).toBeUndefined();
    expect(body.model).toBe('auto');
    expect(body.history_and_training_disabled).toBe(true);
    expect(String(init.body)).not.toMatch(/codex/i);
  });

  it('keeps a browser-check failure distinct from an expired session', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"detail":"sentinel proof required"}', { status: 403 }));
    await expect(
      requestChatGptText(
        {
          accessToken: 'access',
          accountId: 'acct_123',
          model: 'auto',
          instructions: 'Be brief.',
          input: 'Hello',
        },
        fetchImpl as typeof fetch,
      ),
    ).rejects.toThrow(/verify this browser session/);
  });

  it('reports an unauthorized conversation call as an expired session', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"detail":"Unauthorized"}', { status: 401 }));
    await expect(
      requestChatGptText(
        {
          accessToken: 'access',
          accountId: 'acct_123',
          model: 'auto',
          instructions: 'Be brief.',
          input: 'Hello',
        },
        fetchImpl as typeof fetch,
      ),
    ).rejects.toThrow('ChatGPT session expired. Sign in again.');
  });
});

describe('prompt-backed provider', () => {
  it('extracts fenced JSON', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"text":"Hi"}\n```')).toEqual({ text: 'Hi' });
  });

  it('classifies from a JSON object', async () => {
    const provider = createPromptBackedProvider('test', async () => ({
      text: JSON.stringify({
        category: 'RESPOND',
        confidence: 0.91,
        priority: 'HIGH',
        needsReply: true,
        waitingOnReply: false,
        archiveRecommendation: false,
        reason: 'Question for you',
        deadline: null,
      }),
    }));
    const { result } = await provider.classifyEmail({
      subject: 'Need a decision',
      snippet: 'Can you confirm?',
      bodyText: 'Can you confirm the date?',
      latestSender: 'a@example.com',
      direction: 'inbound',
    });
    expect(result.category).toBe('RESPOND');
    expect(result.needsReply).toBe(true);
  });

  it('repairs invalid JSON once', async () => {
    let calls = 0;
    const provider = createPromptBackedProvider('test', async () => {
      calls += 1;
      if (calls === 1) return { text: 'not json' };
      return {
        text: JSON.stringify({
          oneLine: 'A short update',
          keyPoints: ['Shipped'],
          decisions: [],
          unansweredQuestions: [],
          commitments: [],
          dates: [],
          actionItems: [],
        }),
      };
    });
    const { result } = await provider.summarizeThread({
      subject: 'Update',
      messages: [{ sender: 'a@example.com', bodyText: 'Shipped', timestamp: '2026-09-01' }],
    });
    expect(calls).toBe(2);
    expect(result.oneLine).toBe('A short update');
  });

  it('asks the selected model for a short formatted summary', async () => {
    let system = '';
    const provider = createPromptBackedProvider('test', async (prompt) => {
      system = prompt;
      return { text: JSON.stringify({ oneLine: 'ACA invited you to the Berkeley China Summit.' }) };
    });
    await provider.summarizeThread({
      subject: 'Berkeley China Summit',
      messages: [{ sender: 'aca@example.com', bodyText: 'Hi all, we are excited to share an opportunity.', timestamp: '' }],
    });
    expect(system).toContain('one complete sentence');
    expect(system).toContain('Do not start with Hi');
    expect(system).toContain('actionItems');
    expect(system).toContain('Return one JSON object only');
  });

  it('accepts a summary that only includes the one-line field', async () => {
    const provider = createPromptBackedProvider('test', async () => ({
      text: JSON.stringify({ summary: 'The weekend sale starts Friday.' }),
    }));
    const { result } = await provider.summarizeThread({
      subject: 'Sale',
      messages: [{ sender: 'deals@shop.test', bodyText: 'The weekend sale starts Friday.', timestamp: '' }],
    });
    expect(result.oneLine).toBe('The weekend sale starts Friday.');
    expect(result.keyPoints).toEqual([]);
  });
});
