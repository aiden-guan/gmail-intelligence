/**
 * Optional dedicated inactive Gmail worker tab controller.
 * Reuses a single tab; does not constantly open/close.
 * Actions are serialized through the caller's GmailActionAdapter.
 *
 * This module is environment-agnostic regarding chrome.* — inject chrome APIs.
 */
export type ChromeTabsLike = {
  query: (q: { url?: string | string[]; pinned?: boolean }) => Promise<Array<{ id?: number; url?: string; pinned?: boolean }>>;
  create: (props: { url: string; active?: boolean; pinned?: boolean }) => Promise<{ id?: number }>;
  update: (tabId: number, props: { url?: string; active?: boolean; pinned?: boolean }) => Promise<unknown>;
  get: (tabId: number) => Promise<{ id?: number; url?: string } | undefined>;
};

export class WorkerTabController {
  private tabId: number | null = null;
  private busy = false;

  constructor(
    private readonly chromeTabs: ChromeTabsLike,
    private readonly gmailUrl = 'https://mail.google.com/mail/u/0/#inbox',
  ) {}

  async ensureTab(opts: { pinned?: boolean; active?: boolean } = {}): Promise<number> {
    if (this.tabId != null) {
      try {
        const t = await this.chromeTabs.get(this.tabId);
        if (t?.id != null && t.url?.includes('mail.google.com')) {
          return t.id;
        }
      } catch {
        this.tabId = null;
      }
    }
    const existing = await this.chromeTabs.query({
      url: ['https://mail.google.com/*', 'https://mail.google.com/mail/*'],
    });
    const reusable = existing.find((t) => t.id != null);
    if (reusable?.id != null) {
      this.tabId = reusable.id;
      if (opts.pinned) {
        await this.chromeTabs.update(reusable.id, { pinned: true });
      }
      return reusable.id;
    }
    const created = await this.chromeTabs.create({
      url: this.gmailUrl,
      active: opts.active ?? false,
      pinned: opts.pinned ?? false,
    });
    if (created.id == null) throw new Error('failed to create worker tab');
    this.tabId = created.id;
    return created.id;
  }

  getTabId(): number | null {
    return this.tabId;
  }

  isBusy(): boolean {
    return this.busy;
  }

  async runExclusive<T>(fn: (tabId: number) => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new Error('worker tab busy — serialize actions');
    }
    this.busy = true;
    try {
      const tabId = await this.ensureTab({ active: false });
      return await fn(tabId);
    } finally {
      this.busy = false;
    }
  }

  async navigate(hashOrUrl: string): Promise<void> {
    const tabId = await this.ensureTab();
    const url = hashOrUrl.startsWith('http')
      ? hashOrUrl
      : `https://mail.google.com/mail/u/0/${hashOrUrl.replace(/^#/, '#')}`;
    await this.chromeTabs.update(tabId, { url });
  }
}
