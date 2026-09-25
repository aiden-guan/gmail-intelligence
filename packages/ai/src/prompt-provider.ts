import {
  ClassificationResultSchema,
  DraftSuggestionSchema,
  ThreadSummarySchema,
  sanitizeDates,
  type DraftSuggestion,
  type ThreadSummary,
} from '@gi/shared';
import { z } from 'zod';
import type {
  AIProvider,
  AskInput,
  ClassifyInput,
  DraftInput,
  RewriteInput,
  SummarizeInput,
  UsageStats,
} from './index.js';
import {
  EMAIL_SUMMARY_SYSTEM_PROMPT,
  LOCAL_EMAIL_SUMMARY_SYSTEM_PROMPT,
  formatThreadForSummary,
  summaryUserContent,
} from './summary-prompt.js';
import { draftQualityIssue, draftSystemPrompt, formatDraftContext } from './draft-prompt.js';

const AskSchema = z.object({
  answer: z.string(),
  citations: z.array(z.object({ threadId: z.string(), subject: z.string() })),
  incompleteIndex: z.boolean(),
});

export type PromptCompletion = {
  text: string;
  usage?: UsageStats;
};

export type PromptComplete = (system: string, user: string) => Promise<PromptCompletion>;

const JSON_RULE = 'Return one JSON object only. No markdown fences and no explanation.';

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? trimmed;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI returned non-JSON');
  return JSON.parse(source.slice(start, end + 1)) as unknown;
}

export function createPromptBackedProvider(
  name: string,
  complete: PromptComplete,
  options?: { maxUserChars?: number; summaryStyle?: 'compact' | 'full'; repairInvalidJson?: boolean },
): AIProvider {
  const maxUserChars = options?.maxUserChars ?? 12_000;
  const summaryStyle = options?.summaryStyle ?? 'full';
  const repairInvalidJson = options?.repairInvalidJson ?? true;

  async function chatJson<T>(system: string, user: string, schema: z.ZodType<T>): Promise<{
    data: T;
    usage?: UsageStats;
  }> {
    const first = await complete(`${system} ${JSON_RULE}`, clip(user, maxUserChars));
    try {
      return { data: schema.parse(extractJsonObject(first.text)), usage: first.usage };
    } catch (error) {
      try {
        return { data: schema.parse(first.text), usage: first.usage };
      } catch {
        /* proceed to repair */
      }
      const reason = error instanceof Error ? error.message : 'invalid JSON';
      if (!repairInvalidJson) throw new Error(`AI returned invalid JSON: ${reason}`);
      const repair = await complete(
        `Fix the JSON so it matches the requested object. Include every required key. Use empty arrays or empty strings when a value is missing. ${JSON_RULE}`,
        clip(`Problem: ${reason}\n\nPrevious output:\n${first.text}`, maxUserChars),
      );
      try {
        return { data: schema.parse(extractJsonObject(repair.text)), usage: repair.usage ?? first.usage };
      } catch {
        return { data: schema.parse(repair.text), usage: repair.usage ?? first.usage };
      }
    }
  }

  return {
    name,
    async classifyEmail(input: ClassifyInput) {
      const { data, usage } = await chatJson(
        'You classify emails. Use category RESPOND, WAITING, FYI, NOTIFICATIONS, PROMOTIONS, or NEWS. priority is HIGH, NORMAL, or LOW. confidence is 0 to 1. deadline is a string or null.',
        JSON.stringify({
          ...input,
          snippet: clip(input.snippet, 500),
          bodyText: clip(input.bodyText, Math.max(1000, maxUserChars - 1500)),
        }),
        ClassificationResultSchema,
      );
      return { result: data, usage };
    },
    async summarizeThread(input: SummarizeInput) {
      const readable = input.messages.filter((message) => message.bodyText.trim());
      const selected = summaryStyle === 'compact' ? readable.slice(-1) : readable.slice(-8);
      const formatted = formatThreadForSummary({
        subject: input.subject,
        includeOlder: summaryStyle !== 'compact',
        messages: selected.map((message) => ({
          sender: message.sender,
          timestamp: message.timestamp,
          bodyText: clip(message.bodyText, Math.max(800, Math.floor(maxUserChars / 8))),
        })),
      });
      const { data, usage } = await chatJson(
        summaryStyle === 'compact' ? LOCAL_EMAIL_SUMMARY_SYSTEM_PROMPT : EMAIL_SUMMARY_SYSTEM_PROMPT,
        summaryUserContent(formatted, summaryStyle),
        z.preprocess(coerceThreadSummary, ThreadSummarySchema) as z.ZodType<ThreadSummary>,
      );
      return { result: data, usage };
    },
    async draftReply(input: DraftInput) {
      return draft(chatJson, input, 'reply', summaryStyle, maxUserChars);
    },
    async draftFollowUp(input: DraftInput) {
      return draft(chatJson, input, 'follow_up', summaryStyle, maxUserChars);
    },
    async rewriteText(input: RewriteInput) {
      const schema = z.object({ text: z.string() });
      const { data, usage } = await chatJson(
        `Rewrite email text. Mode=${input.mode}. Preserve meaning. JSON shape {"text":""}.`,
        JSON.stringify({
          ...input,
          text: clip(input.text, Math.max(1000, maxUserChars - 800)),
        }),
        schema,
      );
      return { result: data.text, usage };
    },
    async answerMailboxQuery(input: AskInput) {
      const { data, usage } = await chatJson(
        `Answer ONLY from the mailbox context. Every factual claim needs citations. If the context is incomplete, set incompleteIndex true and say the local index may be incomplete. Coverage: ${input.coverageNote}`,
        JSON.stringify({
          query: input.query,
          contextChunks: input.contextChunks.slice(0, 8).map((chunk) => ({
            ...chunk,
            text: clip(chunk.text, 1500),
          })),
        }),
        AskSchema,
      );
      return { result: data, usage };
    },
    async embed(): Promise<{ vectors: number[][] }> {
      throw new Error('This model does not create embeddings. Ask Inbox still searches the local index.');
    },
  };
}

async function draft(
  chatJson: <T>(system: string, user: string, schema: z.ZodType<T>) => Promise<{ data: T; usage?: UsageStats }>,
  input: DraftInput,
  kind: 'reply' | 'follow_up',
  contextStyle: 'compact' | 'full',
  maxUserChars: number,
): Promise<{ result: DraftSuggestion; usage?: UsageStats }> {
  const { data, usage } = await chatJson(
    draftSystemPrompt(input, kind, contextStyle === 'compact'),
    formatDraftContext(input, kind, contextStyle, maxUserChars),
    z.preprocess(coerceDraftSuggestion, DraftSuggestionSchema) as z.ZodType<DraftSuggestion>,
  );
  const qualityIssue = draftQualityIssue(input.messages, data.body);
  if (qualityIssue) throw new Error(qualityIssue);
  return {
    result: {
      mode: data.mode ?? 'direct',
      body: data.body,
      placeholders: data.placeholders ?? [],
      subject: data.subject,
      confidence: data.confidence,
    },
    usage,
  };
}

export function coerceDraftSuggestion(value: unknown): unknown {
  if (typeof value === 'string') {
    const nested = parseDraftEnvelope(value);
    if (nested) return coerceDraftSuggestion(nested);
    const cleaned = cleanDraftBody(value);
    return {
      mode: 'direct',
      body: cleaned,
      placeholders: [],
    };
  }
  const record = asRecord(value);
  if (!record) return value;
  const body = firstString(record, [
    'body',
    'reply',
    'text',
    'draft',
    'message',
    'content',
    'response',
    'email',
    'suggestion',
  ]);
  if (!body) return value;
  const nested = parseDraftEnvelope(body);
  return {
    mode: firstString(record, ['mode']) || 'direct',
    subject: firstString(record, ['subject']) || undefined,
    body: nested
      ? cleanDraftBody(firstString(nested, ['body', 'reply', 'text', 'draft', 'message', 'content', 'response', 'email']) || '')
      : cleanDraftBody(body),
    placeholders: Array.isArray(record.placeholders) ? record.placeholders : [],
    confidence: typeof record.confidence === 'number' ? record.confidence : undefined,
  };
}

function parseDraftEnvelope(text: string): Record<string, unknown> | null {
  const trimmed = stripMarkdownPreamble(text.trim());
  const candidates = [trimmed, trimmed.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')];
  for (const candidate of candidates) {
    try {
      const parsed = extractJsonObject(candidate);
      const record = asRecord(parsed);
      if (
        record &&
        typeof record.body === 'string' &&
        (typeof record.mode === 'string' || typeof record.subject === 'string' || Array.isArray(record.placeholders))
      ) {
        return record;
      }
    } catch {
      /* This is ordinary draft text, not a nested payload. */
    }
  }
  return null;
}

function cleanDraftBody(text: string): string {
  let body = stripMarkdownPreamble(text.trim());
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = parseDraftEnvelope(body);
    if (!nested) break;
    const nestedBody = firstString(nested, ['body', 'reply', 'text', 'draft', 'message', 'content', 'response', 'email']);
    if (!nestedBody || nestedBody === body) break;
    body = stripMarkdownPreamble(nestedBody.trim());
  }
  return body;
}

function stripMarkdownPreamble(text: string): string {
  return text
    .replace(/^```(?:markdown|email|text|json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^(?:Here is a (?:draft|reply|response)[^:\n]*:?\s*)+/i, '')
    .trim();
}

/** Accept the shorter objects models actually return. */
export function coerceThreadSummary(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const reasoning = firstString(record, ['reasoning', 'analysis', 'thought', 'thoughts', 'explanation']);
  const oneLine = firstString(record, ['oneLine', 'one_line', 'summary', 'tldr', 'tl_dr']);
  if (!oneLine) return value;
  const rawQuestions = stringList(record.unansweredQuestions ?? record.unanswered_questions ?? record.questions);
  const filteredQuestions = rawQuestions.filter(
    (q) =>
      !/\b(?:want|looking for|ready for|interested in|why not|why wait|did you know|have you heard|how about|need a|questions\?)\b/i.test(
        q,
      ),
  );
  return {
    reasoning: reasoning ? clip(reasoning, 1000) : undefined,
    oneLine: clip(oneLine, 400),
    keyPoints: stringList(record.keyPoints ?? record.key_points ?? record.points),
    decisions: stringList(record.decisions),
    unansweredQuestions: filteredQuestions,
    commitments: stringList(record.commitments),
    dates: sanitizeDates(stringList(record.dates)),
    actionItems: stringList(record.actionItems ?? record.action_items ?? record.actions),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(' ');
      if (joined) return joined;
    }
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string' && isCleanItem(item))
      .map((item) => clip(item.replace(/^[•\s\-*–—]+/, '').trim(), 240))
      .filter((item) => item.length > 0)
      .slice(0, 8);
  }
  if (typeof value === 'string' && isCleanItem(value)) {
    return [clip(value.replace(/^[•\s\-*–—]+/, '').trim(), 240)];
  }
  return [];
}

function isCleanItem(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  if (!/[a-zA-Z]{2,}/.test(trimmed)) return false;
  if (/^[.\s…\-_?]+$/.test(trimmed)) return false;
  return true;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 2) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}
