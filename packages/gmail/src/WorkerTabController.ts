/**
 * Dedicated inactive Gmail worker tab.
 * Never reuses an arbitrary Gmail tab the user already has open.
 * Actions wait in one queue.
 */
export type ChromeTabsLike = {
  query: (q: { url?: string | string[]; pinned?: boolean; active?: boolean; currentWindow?: boolean }) => Promise<
    Array<{ id?: number; url?: string; pinned?: boolean; active?: boolean }>
  >;
  create: (props: { url: string; active?: boolean; pinned?: boolean }) => Promise<{ id?: number }>;
  update: (tabId: number, props: { url?: string; active?: boolean; pinned?: boolean }) => Promise<unknown>;
  get: (tabId: number) => Promise<{ id?: number; url?: string; pinned?: boolean } | undefined>;
};

export class WorkerTabController {
  private tabId: number | null = null;
  private busy = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly chromeTabs: ChromeTabsLike,
    private readonly gmailUrl = 'https://mail.google.com/mail/u/0/#inbox',
  ) {}

  async ensureTab(opts: { pinned?: boolean; active?: boolean } = {}): Promise<number> {
    if (this.tabId != null) {
      try {
        const existing = await this.chromeTabs.get(this.tabId);
        if (existing?.id != null && existing.url?.includes('mail.google.com')) {
          if (opts.pinned && existing.pinned !== true) {
            await this.chromeTabs.update(existing.id, { pinned: true, active: false });
          }
          return existing.id;
        }
      } catch {
        this.tabId = null;
      }
    }
    const created = await this.chromeTabs.create({
      url: this.gmailUrl,
      active: false,
      pinned: opts.pinned ?? true,
    });
    if (created.id == null) throw new Error('failed to create worker tab');
    this.tabId = created.id;
    return created.id;
  }

  getTabId(): number | null {
    return this.tabId;
  }

  /** Remember a tab this controller created, for tests and reloads. */
  adopt(tabId: number): void {
    this.tabId = tabId;
  }

  isBusy(): boolean {
    return this.busy;
  }

  async runExclusive<T>(fn: (tabId: number) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.busy = true;
      try {
        const tabId = await this.ensureTab({ active: false, pinned: true });
        return await fn(tabId);
      } finally {
        this.busy = false;
      }
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  }

  async navigate(hashOrUrl: string): Promise<void> {
    const tabId = await this.ensureTab({ active: false, pinned: true });
    const url = hashOrUrl.startsWith('http')
      ? hashOrUrl
      : `https://mail.google.com/mail/u/0/${hashOrUrl.startsWith('#') ? hashOrUrl : `#${hashOrUrl}`}`;
    await this.chromeTabs.update(tabId, { url, active: false });
  }
}
