import type { Contact, ThreadDataQuality, ThreadDataSource } from '@gi/shared';
import type { CurrentThreadView, ThreadMessageView, VisibleThreadRow } from './types.js';

export type NormalizedMessage = Omit<ThreadMessageView, 'timestamp'> & { timestamp?: string };

export type NormalizedThread = {
  threadId: string;
  subject: string;
  participants: Contact[];
  latestSender?: Contact;
  timestamp?: string;
  snippet: string;
  messages: NormalizedMessage[];
  quality: ThreadDataQuality;
  source: ThreadDataSource;
  messageCount: number;
  route: string;
};

const STUB_ID = /-(row|visible|unknown)$/;

export function isUsableTimestamp(value: string | undefined | null): value is string {
  if (!value) return false;
  return Number.isFinite(Date.parse(value));
}

export function normalizeVisibleRow(
  row: VisibleThreadRow,
  source: ThreadDataSource,
  route = 'inbox',
): NormalizedThread {
  return {
    threadId: row.threadId,
    subject: row.subject,
    participants: row.participants,
    latestSender: row.latestSender,
    timestamp: isUsableTimestamp(row.latestTimestamp) ? row.latestTimestamp : undefined,
    snippet: row.snippet,
    messages: [],
    quality: 'ROW_STUB',
    source,
    messageCount: row.messageCount && row.messageCount > 0 ? row.messageCount : 1,
    route,
  };
}

export function normalizeOpenedThread(
  thread: CurrentThreadView,
  source: ThreadDataSource,
): NormalizedThread {
  const messages: NormalizedMessage[] = thread.messages.map((message) => ({
    ...message,
    timestamp: isUsableTimestamp(message.timestamp) ? message.timestamp : undefined,
  }));
  const usable = messages.filter(
    (message) => message.bodyText.trim().length > 0 && !STUB_ID.test(message.messageId),
  );
  const quality: ThreadDataQuality =
    messages.length > 0 && usable.length === messages.length
      ? 'THREAD_COMPLETE'
      : usable.length > 0
        ? 'THREAD_PARTIAL'
        : 'ROW_STUB';
  const latest = messages.at(-1);
  const participants = dedupeContacts(
    messages.map((message) => message.sender).filter((sender) => sender.email),
  );
  return {
    threadId: thread.threadId,
    subject: thread.subject,
    participants,
    latestSender: latest?.sender?.email ? latest.sender : undefined,
    timestamp: latest?.timestamp,
    snippet: (latest?.bodyText || thread.subject).slice(0, 180),
    messages: quality === 'ROW_STUB' ? [] : messages,
    quality,
    source,
    messageCount: Math.max(messages.length, 1),
    route: thread.route,
  };
}

function dedupeContacts(contacts: Contact[]): Contact[] {
  const seen = new Set<string>();
  const out: Contact[] = [];
  for (const contact of contacts) {
    const key = contact.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(contact);
  }
  return out;
}
