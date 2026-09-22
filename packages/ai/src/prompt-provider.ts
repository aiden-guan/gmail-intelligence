import {
  ClassificationResultSchema,
  DraftSuggestionSchema,
  ThreadSummarySchema,
  type DraftSuggestion,
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
  options?: { maxUserChars?: number },
): AIProvider {
  const maxUserChars = options?.maxUserChars ?? 12_000;

  async function chatJson<T>(system: string, user: string, schema: z.ZodType<T>): Promise<{
    data: T;
    usage?: UsageStats;
  }> {
    const first = await complete(`${system} ${JSON_RULE}`, clip(user, maxUserChars));
    try {
      return { data: schema.parse(extractJsonObject(first.text)), usage: first.usage };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid JSON';
      const repair = await complete(
        `Fix the JSON so it matches the requested object. ${JSON_RULE}`,
        clip(`Problem: ${reason}\n\nPrevious output:\n${first.text}`, maxUserChars),
      );
      return { data: schema.parse(extractJsonObject(repair.text)), usage: repair.usage ?? first.usage };
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
      const { data, usage } = await chatJson(
        'Summarize the email thread. oneLine is under 200 characters. keyPoints, decisions, unansweredQuestions, commitments, dates, and actionItems are short string arrays.',
        JSON.stringify({
          subject: input.subject,
          messages: input.messages.slice(-8).map((message) => ({
            sender: message.sender,
            timestamp: message.timestamp,
            bodyText: clip(message.bodyText, Math.max(800, Math.floor(maxUserChars / 8))),
          })),
        }),
        ThreadSummarySchema,
      );
      return { result: data, usage };
    },
    async draftReply(input: DraftInput) {
      return draft(chatJson, input, 'reply');
    },
    async draftFollowUp(input: DraftInput) {
      return draft(chatJson, input, 'follow_up');
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
): Promise<{ result: DraftSuggestion; usage?: UsageStats }> {
  const instruction =
    kind === 'reply'
      ? `Draft a reply email in the user's voice. Never send. Use placeholders [DATE][TIME][LINK][NAME][ATTACHMENT][AMOUNT] when facts are missing. Mode=${input.mode || 'direct'}.`
      : 'Draft a polite follow-up. Never send. Use placeholders for missing facts.';
  const { data, usage } = await chatJson(
    `${instruction} JSON keys: mode, subject, body, placeholders, confidence.`,
    JSON.stringify({
      ...input,
      kind,
      messages: input.messages.slice(-6).map((message) => ({
        ...message,
        bodyText: message.bodyText.slice(0, 4000),
      })),
    }),
    DraftSuggestionSchema,
  );
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

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
