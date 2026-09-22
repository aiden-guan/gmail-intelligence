import type { GmailActionResult } from '@gi/shared';
import type { GmailAdapter, QueuedGmailAction } from './types.js';

export type ActionQueueItem = {
  id: string;
  action: QueuedGmailAction;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  precondition?: () => Promise<boolean>;
  verify?: () => Promise<boolean>;
  timeoutMs: number;
};

export type ActionQueueResult = GmailActionResult & {
  actionId: string;
  verified?: boolean;
};

/**
 * Serialized Gmail UI action engine.
 * ONLY ONE automation action at a time.
 * Each action: precondition → execute → verify → retry/fail.
 */
export class GmailActionAdapter {
  private queue: ActionQueueItem[] = [];
  private running = false;
  private paused = false;
  private waiters = new Map<string, (result: ActionQueueResult) => void>();

  constructor(
    private readonly adapter: GmailAdapter,
    private readonly opts: { defaultTimeoutMs?: number; defaultMaxAttempts?: number } = {},
  ) {}

  enqueue(
    action: QueuedGmailAction,
    extras: Partial<Pick<ActionQueueItem, 'precondition' | 'verify' | 'timeoutMs' | 'maxAttempts'>> = {},
  ): string {
    const id = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.queue.push({
      id,
      action,
      attempts: 0,
      maxAttempts: extras.maxAttempts ?? this.opts.defaultMaxAttempts ?? 3,
      createdAt: Date.now(),
      precondition: extras.precondition,
      verify: extras.verify,
      timeoutMs: extras.timeoutMs ?? this.opts.defaultTimeoutMs ?? 15_000,
    });
    void this.pump();
    return id;
  }

  /** Enqueue and wait for structured success/failure (never pretends success). */
  enqueueAndWait(
    action: QueuedGmailAction,
    extras: Partial<Pick<ActionQueueItem, 'precondition' | 'verify' | 'timeoutMs' | 'maxAttempts'>> = {},
  ): Promise<ActionQueueResult> {
    return new Promise((resolve) => {
      const id = this.enqueue(action, extras);
      this.waiters.set(id, resolve);
    });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    void this.pump();
  }

  get pending(): number {
    return this.queue.length;
  }

  private resolveWaiter(result: ActionQueueResult): void {
    const waiter = this.waiters.get(result.actionId);
    if (waiter) {
      this.waiters.delete(result.actionId);
      waiter(result);
    }
  }

  private async pump(): Promise<void> {
    if (this.running || this.paused) return;
    const item = this.queue.shift();
    if (!item) return;
    this.running = true;
    try {
      const result = await this.runOne(item);
      this.resolveWaiter(result);
    } finally {
      this.running = false;
      if (this.queue.length) void this.pump();
    }
  }

  private async runOne(item: ActionQueueItem): Promise<ActionQueueResult> {
    while (item.attempts < item.maxAttempts) {
      item.attempts += 1;
      try {
        if (item.precondition) {
          const okPre = await withTimeout(item.precondition(), item.timeoutMs);
          if (!okPre) {
            continue;
          }
        }
        const result = await withTimeout(this.execute(item.action), item.timeoutMs);
        if (!result.success) {
          if (!result.retryable || item.attempts >= item.maxAttempts) {
            return { ...result, actionId: item.id, verified: false };
          }
          await sleep(Math.min(2000 * 2 ** (item.attempts - 1), 10_000));
          continue;
        }
        if (item.verify) {
          const verified = await withTimeout(item.verify(), item.timeoutMs);
          if (!verified) {
            await sleep(500 * item.attempts);
            continue;
          }
          return { ...result, actionId: item.id, verified: true };
        }
        return { ...result, actionId: item.id };
      } catch (err) {
        if (item.attempts >= item.maxAttempts) {
          return {
            success: false,
            capability: item.action.kind,
            error: String(err),
            retryable: false,
            actionId: item.id,
          };
        }
        await sleep(Math.min(2000 * 2 ** (item.attempts - 1), 10_000));
      }
    }
    return {
      success: false,
      capability: item.action.kind,
      error: 'max attempts exceeded',
      retryable: false,
      actionId: item.id,
    };
  }

  private async execute(action: QueuedGmailAction): Promise<GmailActionResult> {
    switch (action.kind) {
      case 'ARCHIVE_THREAD':
        return this.adapter.archiveThread(action.threadId);
      case 'MARK_READ':
        return this.adapter.markRead(action.threadId);
      case 'MARK_UNREAD':
        return this.adapter.markUnread(action.threadId);
      case 'STAR':
        return this.adapter.starThread(action.threadId);
      case 'OPEN_THREAD':
        return this.adapter.openThread(action.threadId);
      case 'CREATE_REPLY_DRAFT':
        return this.adapter.createReplyDraft(action.threadId);
      case 'INSERT_COMPOSE_BODY':
        return this.adapter.insertComposeBody(action.text);
      case 'NAVIGATE_SEARCH':
        return this.adapter.navigateToSearch(action.query);
      case 'NAVIGATE_INBOX':
        return this.adapter.navigateToInbox();
      default: {
        const _exhaustive: never = action;
        return { success: false, capability: 'unknown', error: String(_exhaustive) };
      }
    }
  }

  /**
   * ARCHIVE_THREAD with verification: open → archive → confirm row gone / left inbox.
   */
  enqueueArchiveVerified(
    threadId: string,
    isStillInInbox: () => Promise<boolean>,
  ): string {
    return this.enqueue(
      { kind: 'ARCHIVE_THREAD', threadId },
      {
        precondition: async () => {
          const opened = await this.adapter.openThread(threadId);
          return opened.success;
        },
        verify: async () => {
          // Success only if thread is no longer in inbox view
          const still = await isStillInInbox();
          return !still;
        },
        maxAttempts: 3,
        timeoutMs: 20_000,
      },
    );
  }

  enqueueArchiveVerifiedAndWait(
    threadId: string,
    isStillInInbox: () => Promise<boolean>,
  ): Promise<ActionQueueResult> {
    return this.enqueueAndWait(
      { kind: 'ARCHIVE_THREAD', threadId },
      {
        precondition: async () => {
          const opened = await this.adapter.openThread(threadId);
          return opened.success;
        },
        verify: async () => {
          const still = await isStillInInbox();
          return !still;
        },
        maxAttempts: 3,
        timeoutMs: 20_000,
      },
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
