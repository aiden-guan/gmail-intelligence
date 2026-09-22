import {
  contentFingerprint,
  hashBody,
  stripHtml,
} from '@gi/shared';
import { getMailboxDb, type MailboxDatabase } from './db.js';
import type {
  IndexCheckpoint,
  IndexCoverage,
  IngestThread,
  MailboxSource,
  MessageRow,
  ThreadRow,
} from './types.js';

export class GmailWebSource implements MailboxSource {
  readonly kind = 'gmail-web' as const;

  constructor(
    private readonly observeVisible: () => Promise<IngestThread[]>,
    private readonly observeCurrent: () => Promise<IngestThread | null>,
  ) {}

  observeVisibleThreads(): Promise<IngestThread[]> {
    return this.observeVisible();
  }

  observeCurrentThread(): Promise<IngestThread | null> {
    return this.observeCurrent();
  }
}

/** Seam only — not implemented in V1. */
export class FutureImapSource implements MailboxSource {
  readonly kind = 'future-imap' as const;
  async observeVisibleThreads(): Promise<IngestThread[]> {
    throw new Error('FutureImapSource is not implemented in V1');
  }
  async observeCurrentThread(): Promise<IngestThread | null> {
    throw new Error('FutureImapSource is not implemented in V1');
  }
}

export class MailboxIngestor {
  constructor(
    private readonly db: MailboxDatabase = getMailboxDb(),
    private readonly accountId = 'default',
  ) {}

  /**
   * Incremental ingest. Unchanged fingerprint → skip AI reprocessing flags.
   * Does NOT scrape entire mailbox on startup.
   */
  async ingestThread(thread: IngestThread): Promise<{
    changed: boolean;
    fingerprint: string;
    threadId: string;
  }> {
    const latest = thread.messages[thread.messages.length - 1] || {
      messageId: `${thread.threadId}-unknown`,
      timestamp: thread.latestTimestamp,
      bodyText: thread.snippet,
    };
    const bodyText = stripHtml(latest.bodyText || thread.snippet || '');
    const bodyHash = await hashBody(bodyText);
    const fingerprint = await contentFingerprint({
      gmailThreadId: thread.threadId,
      latestMessageId: latest.messageId,
      latestTimestamp: latest.timestamp || thread.latestTimestamp,
      normalizedBodyHash: bodyHash,
    });

    const existing = await this.db.threads.get(thread.threadId);
    if (existing?.contentFingerprint === fingerprint) {
      return { changed: false, fingerprint, threadId: thread.threadId };
    }

    const threadRow: ThreadRow = {
      threadId: thread.threadId,
      accountId: this.accountId,
      subject: thread.subject,
      participants: thread.participants,
      latestSender: thread.latestSender,
      latestTimestamp: thread.latestTimestamp,
      messageCount: thread.messageCount || thread.messages.length,
      snippet: thread.snippet,
      route: thread.route,
      lastIndexedAt: Date.now(),
      contentFingerprint: fingerprint,
      classification: existing?.classification,
      classificationConfidence: existing?.classificationConfidence,
      priority: existing?.priority,
      archivedLocally: existing?.archivedLocally ?? false,
      requiresResponse: existing?.requiresResponse ?? false,
      awaitingResponse: existing?.awaitingResponse ?? false,
      virtualLabels: existing?.virtualLabels ?? [],
    };

    const messageRows: MessageRow[] = [];
    for (const m of thread.messages) {
      const text = stripHtml(m.bodyText || '');
      const fp = await contentFingerprint({
        gmailThreadId: m.threadId,
        latestMessageId: m.messageId,
        latestTimestamp: m.timestamp,
        normalizedBodyHash: await hashBody(text),
      });
      messageRows.push({
        messageId: m.messageId,
        threadId: m.threadId,
        accountId: this.accountId,
        sender: m.sender,
        recipients: m.recipients,
        cc: m.cc,
        timestamp: m.timestamp,
        bodyText: text,
        // Do not persist arbitrary HTML for React rendering; optional raw kept stripped-use only
        bodyHtml: undefined,
        attachmentsMetadata: m.attachmentsMetadata || [],
        fingerprint: fp,
      });
    }

    await this.db.transaction('rw', this.db.threads, this.db.messages, this.db.contacts, this.db.search_documents, async () => {
      await this.db.threads.put(threadRow);
      for (const mr of messageRows) {
        await this.db.messages.put(mr);
        await this.db.contacts.put({
          email: mr.sender.email,
          accountId: this.accountId,
          name: mr.sender.name,
          lastSeenAt: Date.now(),
          messageCount: 1,
        });
      }
      const searchText = [
        thread.subject,
        thread.snippet,
        ...messageRows.map((m) => m.bodyText),
      ].join('\n');
      await this.db.search_documents.put({
        id: thread.threadId,
        threadId: thread.threadId,
        text: searchText.slice(0, 100_000),
        subject: thread.subject,
        senders: thread.participants.map((p) => p.email).join(' '),
        recipients: messageRows.flatMap((m) => m.recipients.map((r) => r.email)).join(' '),
        labels: (threadRow.virtualLabels || []).join(' '),
        timestamp: thread.latestTimestamp,
        fingerprint,
      });
    });

    return { changed: true, fingerprint, threadId: thread.threadId };
  }

  async getCoverage(): Promise<IndexCoverage> {
    const threads = await this.db.threads.toArray();
    const sync = await this.db.sync_state.get('index_coverage');
    const checkpoint = (await this.db.sync_state.get('index_checkpoint'))?.value as
      | IndexCheckpoint
      | undefined;
    const dates = threads
      .map((t) => t.latestTimestamp)
      .filter(Boolean)
      .sort();
    const state =
      checkpoint?.status === 'running'
        ? 'running'
        : checkpoint?.status === 'paused'
          ? 'paused'
          : checkpoint?.status === 'error'
            ? 'error'
            : 'idle';

    return {
      inboxCoverage: (sync?.value as IndexCoverage | undefined)?.inboxCoverage || (threads.length ? 'partial' : 'none'),
      recentMailCoverage: threads.length ? 'partial' : 'none',
      sentMailCoverage: (sync?.value as IndexCoverage | undefined)?.sentMailCoverage || 'none',
      totalIndexedThreads: threads.length,
      oldestIndexedDate: dates[0] || null,
      newestIndexedDate: dates[dates.length - 1] || null,
      lastSuccessfulScan: (sync?.value as { lastSuccessfulScan?: number } | undefined)?.lastSuccessfulScan ?? null,
      state,
      lastError: checkpoint?.error,
    };
  }

  async saveCheckpoint(cp: IndexCheckpoint): Promise<void> {
    await this.db.sync_state.put({ key: 'index_checkpoint', value: cp });
  }

  async loadCheckpoint(): Promise<IndexCheckpoint | null> {
    const row = await this.db.sync_state.get('index_checkpoint');
    return (row?.value as IndexCheckpoint) || null;
  }

  async clearIndex(): Promise<void> {
    await this.db.transaction(
      'rw',
      [
        this.db.threads,
        this.db.messages,
        this.db.search_documents,
        this.db.embeddings,
        this.db.thread_classifications,
        this.db.thread_summaries,
        this.db.draft_suggestions,
      ],
      async () => {
        await Promise.all([
          this.db.threads.clear(),
          this.db.messages.clear(),
          this.db.search_documents.clear(),
          this.db.embeddings.clear(),
          this.db.thread_classifications.clear(),
          this.db.thread_summaries.clear(),
          this.db.draft_suggestions.clear(),
        ]);
      },
    );
  }
}

/**
 * Optional "Index My Inbox" — user-triggered only.
 * Bounded queue, concurrency 1, pacing, checkpointing, crash recovery.
 */
export class IndexJobRunner {
  private paused = false;
  private stopped = false;

  constructor(
    private readonly ingestor: MailboxIngestor,
    private readonly fetchBatch: (query: string, cursor?: string) => Promise<{
      threads: IngestThread[];
      nextCursor?: string;
      error?: string;
      captchaOrBlock?: boolean;
    }>,
  ) {}

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(opts: {
    mode: '7d' | '30d' | '90d' | '1y' | 'custom' | 'sent_sample';
    customQuery?: string;
    paceMs?: number;
  }): Promise<IndexCheckpoint> {
    this.stopped = false;
    this.paused = false;
    const query = buildIndexQuery(opts.mode, opts.customQuery);
    let cp = (await this.ingestor.loadCheckpoint()) || {
      mode: opts.mode,
      customQuery: opts.customQuery,
      processedThreadIds: [],
      status: 'running' as const,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (cp.mode !== opts.mode || cp.customQuery !== opts.customQuery) {
      cp = {
        mode: opts.mode,
        customQuery: opts.customQuery,
        processedThreadIds: [],
        status: 'running',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      cp.status = 'running';
    }
    await this.ingestor.saveCheckpoint(cp);

    let cursor = cp.cursor;
    const pace = opts.paceMs ?? 1200;
    const processed = new Set(cp.processedThreadIds);

    while (!this.stopped) {
      while (this.paused) {
        cp.status = 'paused';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        await sleep(400);
        if (this.stopped) break;
      }
      if (this.stopped) break;

      const batch = await this.fetchBatch(query, cursor);
      if (batch.captchaOrBlock || batch.error) {
        cp.status = 'error';
        cp.error = batch.error || 'Gmail blocked or unexpected state';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        return cp;
      }
      if (!batch.threads.length) {
        cp.status = 'completed';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        return cp;
      }

      const sizeBefore = processed.size;
      for (const t of batch.threads) {
        if (processed.has(t.threadId)) continue;
        await this.ingestor.ingestThread(t);
        processed.add(t.threadId);
        cp.processedThreadIds = [...processed].slice(-5000);
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        await sleep(pace);
        if (this.paused || this.stopped) break;
      }

      cursor = batch.nextCursor;
      cp.cursor = cursor;
      // No new threads this page → done (avoids infinite scroll loops)
      if (processed.size === sizeBefore) {
        cp.status = 'completed';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        return cp;
      }
      if (!cursor) {
        cp.status = 'completed';
        cp.updatedAt = Date.now();
        await this.ingestor.saveCheckpoint(cp);
        return cp;
      }
      // exponential-ish backoff between pages
      await sleep(pace * 1.5);
    }

    cp.status = this.paused ? 'paused' : 'paused';
    cp.updatedAt = Date.now();
    await this.ingestor.saveCheckpoint(cp);
    return cp;
  }
}

export function buildIndexQuery(
  mode: '7d' | '30d' | '90d' | '1y' | 'custom' | 'sent_sample',
  customQuery?: string,
): string {
  switch (mode) {
    case '7d':
      return 'newer_than:7d';
    case '30d':
      return 'newer_than:30d';
    case '90d':
      return 'newer_than:90d';
    case '1y':
      return 'newer_than:365d';
    case 'sent_sample':
      return 'in:sent newer_than:90d';
    case 'custom':
      return customQuery?.trim() || 'in:inbox';
    default:
      return 'in:inbox';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export * from './types.js';
export * from './db.js';
