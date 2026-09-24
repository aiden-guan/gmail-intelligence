import { hashBody, sha256Hex } from './crypto.js';

export type ThreadSnapshotMessage = {
  messageId: string;
  sender: string;
  recipients: string[];
  timestamp: string;
  bodyText: string;
  loaded: boolean;
};

export type ThreadSnapshot = {
  threadId: string;
  subject: string;
  messages: ThreadSnapshotMessage[];
  fingerprint: string;
};

export type RawSnapshotMessage = {
  messageId?: string;
  sender?: string | { email: string; name?: string };
  recipients?: Array<string | { email: string; name?: string }>;
  timestamp?: string;
  bodyText?: string;
  loaded?: boolean;
};

export function normalizeSnapshotMessageId(
  id: string | undefined | null,
  fallbackIndex: number,
  threadId: string,
): string {
  if (!id) return `${threadId}-msg-${fallbackIndex}`;
  const cleaned = id
    .trim()
    .replace(/^#/, '')
    .replace(/^(msg-a:|msg-f:|thread-a:|thread-f:)/i, '');
  return cleaned || `${threadId}-msg-${fallbackIndex}`;
}

function extractEmail(sender: string | { email: string; name?: string } | undefined): string {
  if (!sender) return 'unknown@local';
  if (typeof sender === 'string') return sender.trim() || 'unknown@local';
  return sender.email?.trim() || 'unknown@local';
}

function extractRecipients(
  recipients: Array<string | { email: string; name?: string }> | undefined,
): string[] {
  if (!Array.isArray(recipients)) return [];
  return recipients
    .map((r) => (typeof r === 'string' ? r.trim() : r.email?.trim() || ''))
    .filter(Boolean);
}

export async function computeThreadSnapshotFingerprint(
  threadId: string,
  subject: string,
  messages: ThreadSnapshotMessage[],
): Promise<string> {
  const msgParts = await Promise.all(
    messages.map(async (m) => {
      const bHash = await hashBody(m.bodyText);
      return `${m.messageId}|${m.sender}|${m.timestamp}|${bHash}|${m.loaded}`;
    }),
  );
  return sha256Hex(`${threadId}|${subject.trim()}|${msgParts.join('||')}`);
}

export async function buildThreadSnapshot(opts: {
  threadId: string;
  subject: string;
  pageMessages?: RawSnapshotMessage[];
  storedMessages?: RawSnapshotMessage[];
}): Promise<ThreadSnapshot> {
  const { threadId, subject, pageMessages = [], storedMessages = [] } = opts;

  const pageNormalized: Array<{
    id: string;
    sender: string;
    recipients: string[];
    timestamp: string;
    bodyText: string;
    loaded: boolean;
    order: number;
  }> = [];

  pageMessages.forEach((m, idx) => {
    const id = normalizeSnapshotMessageId(m.messageId, idx, threadId);
    const bodyText = (m.bodyText || '').trim();
    const loaded = typeof m.loaded === 'boolean' ? m.loaded : bodyText.length > 0;
    pageNormalized.push({
      id,
      sender: extractEmail(m.sender),
      recipients: extractRecipients(m.recipients),
      timestamp: (m.timestamp || '').trim(),
      bodyText,
      loaded,
      order: idx,
    });
  });

  const storedNormalized: Array<{
    id: string;
    sender: string;
    recipients: string[];
    timestamp: string;
    bodyText: string;
    loaded: boolean;
    order: number;
  }> = [];

  storedMessages.forEach((m, idx) => {
    const id = normalizeSnapshotMessageId(m.messageId, idx + pageMessages.length, threadId);
    const bodyText = (m.bodyText || '').trim();
    const loaded = typeof m.loaded === 'boolean' ? m.loaded : bodyText.length > 0;
    storedNormalized.push({
      id,
      sender: extractEmail(m.sender),
      recipients: extractRecipients(m.recipients),
      timestamp: (m.timestamp || '').trim(),
      bodyText,
      loaded,
      order: 10000 + idx,
    });
  });

  const pageById = new Map<string, (typeof pageNormalized)[0]>();
  for (const msg of pageNormalized) {
    if (!pageById.has(msg.id)) pageById.set(msg.id, msg);
  }

  const storedById = new Map<string, (typeof storedNormalized)[0]>();
  for (const msg of storedNormalized) {
    if (!storedById.has(msg.id)) storedById.set(msg.id, msg);
  }

  // Collect all unique IDs preserving first appearance order
  const allIds: string[] = [];
  const seenIds = new Set<string>();

  for (const msg of pageNormalized) {
    if (!seenIds.has(msg.id)) {
      seenIds.add(msg.id);
      allIds.push(msg.id);
    }
  }
  for (const msg of storedNormalized) {
    if (!seenIds.has(msg.id)) {
      seenIds.add(msg.id);
      allIds.push(msg.id);
    }
  }

  const mergedMessages: Array<ThreadSnapshotMessage & { order: number }> = [];

  for (const id of allIds) {
    const page = pageById.get(id);
    const stored = storedById.get(id);

    if (page && page.loaded && page.bodyText) {
      // Current loaded page data wins
      mergedMessages.push({
        messageId: id,
        sender: page.sender !== 'unknown@local' ? page.sender : stored?.sender || page.sender,
        recipients: page.recipients.length ? page.recipients : stored?.recipients || [],
        timestamp: page.timestamp || stored?.timestamp || '',
        bodyText: page.bodyText,
        loaded: true,
        order: page.order,
      });
    } else if (page && (!page.loaded || !page.bodyText)) {
      // Page message is unloaded - stored fills missing body if available
      if (stored && stored.bodyText) {
        mergedMessages.push({
          messageId: id,
          sender: page.sender !== 'unknown@local' ? page.sender : stored.sender,
          recipients: page.recipients.length ? page.recipients : stored.recipients,
          timestamp: page.timestamp || stored.timestamp,
          bodyText: stored.bodyText,
          loaded: true,
          order: page.order,
        });
      } else {
        mergedMessages.push({
          messageId: id,
          sender: page.sender,
          recipients: page.recipients,
          timestamp: page.timestamp,
          bodyText: '',
          loaded: false,
          order: page.order,
        });
      }
    } else if (stored) {
      // Only in stored data
      mergedMessages.push({
        messageId: id,
        sender: stored.sender,
        recipients: stored.recipients,
        timestamp: stored.timestamp,
        bodyText: stored.bodyText,
        loaded: stored.loaded,
        order: stored.order,
      });
    }
  }

  // Sort chronologically when timestamps are parseable, otherwise keep appearance order
  mergedMessages.sort((a, b) => {
    const timeA = a.timestamp ? Date.parse(a.timestamp) : Number.NaN;
    const timeB = b.timestamp ? Date.parse(b.timestamp) : Number.NaN;
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
      return timeA - timeB;
    }
    return a.order - b.order;
  });

  const finalMessages: ThreadSnapshotMessage[] = mergedMessages.map((m) => ({
    messageId: m.messageId,
    sender: m.sender,
    recipients: m.recipients,
    timestamp: m.timestamp,
    bodyText: m.bodyText,
    loaded: m.loaded,
  }));

  const fingerprint = await computeThreadSnapshotFingerprint(threadId, subject, finalMessages);

  return {
    threadId,
    subject,
    messages: finalMessages,
    fingerprint,
  };
}
