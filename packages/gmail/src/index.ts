import type { GmailCapabilities } from '@gi/shared';
import { mergeCapabilities } from './capabilities.js';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { MailboxEventBus } from './events.js';
import { GmailActionAdapter } from './GmailActionAdapter.js';
import { GmailJsCaptureAdapter } from './GmailJsCaptureAdapter.js';
import { InboxSdkAdapter, type InboxSdkLike } from './InboxSdkAdapter.js';
import type {
  GmailAdapter,
  MailboxEventHandler,
  QueuedGmailAction,
} from './types.js';

export type CompositeGmailOptions = {
  inboxSdkAppId?: string;
  preferInboxSdk?: boolean;
};

/**
 * Facade: InboxSDK primary → Gmail.js capture secondary → DOM fallback.
 * Application code talks only to this adapter / action queue.
 */
export class CompositeGmailAdapter implements GmailAdapter {
  readonly name = 'composite';
  readonly bus = new MailboxEventBus();
  readonly inboxSdk: InboxSdkAdapter;
  readonly gmailJs: GmailJsCaptureAdapter;
  readonly dom: DomFallbackAdapter;
  readonly actions: GmailActionAdapter;

  private primary: GmailAdapter;
  private caps: GmailCapabilities | null = null;

  constructor(opts: CompositeGmailOptions = {}) {
    this.inboxSdk = new InboxSdkAdapter(opts.inboxSdkAppId || '');
    this.gmailJs = new GmailJsCaptureAdapter();
    this.dom = new DomFallbackAdapter();
    this.primary = this.dom;
    this.actions = new GmailActionAdapter(this);
  }

  bindInboxSdk(sdk: InboxSdkLike): void {
    this.inboxSdk.bindSdk(sdk);
    this.primary = this.inboxSdk;
  }

  async detectCapabilities(): Promise<GmailCapabilities> {
    const [a, b, c] = await Promise.all([
      this.inboxSdk.detectCapabilities(),
      this.gmailJs.detectCapabilities(),
      this.dom.detectCapabilities(),
    ]);
    this.caps = mergeCapabilities(c, b, a);
    return this.caps;
  }

  getCapabilities(): GmailCapabilities | null {
    return this.caps;
  }

  async start(handler: MailboxEventHandler): Promise<void> {
    const wrapped: MailboxEventHandler = (e) => {
      this.bus.emit(e);
      handler(e);
    };
    await this.detectCapabilities();
    if (this.caps?.inboxSdkAvailable) {
      this.primary = this.inboxSdk;
      await this.inboxSdk.start(wrapped);
    } else if (this.caps?.gmailJsCaptureAvailable) {
      this.primary = this.gmailJs;
      await this.gmailJs.start(wrapped);
    } else {
      this.primary = this.dom;
      await this.dom.start(wrapped);
    }
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.inboxSdk.stop(),
      this.gmailJs.stop(),
      this.dom.stop(),
    ]);
  }

  enqueue(action: QueuedGmailAction): string {
    return this.actions.enqueue(action);
  }

  async observeInbox() {
    return this.primary.observeInbox();
  }
  async observeNewMessages() {
    return this.primary.observeNewMessages();
  }
  async observeThreadOpened() {
    return this.primary.observeThreadOpened();
  }
  async observeCompose() {
    return this.primary.observeCompose();
  }
  async getVisibleThreadMetadata() {
    return this.primary.getVisibleThreadMetadata();
  }
  async getCurrentThread() {
    return this.primary.getCurrentThread();
  }
  async getCurrentCompose() {
    return this.primary.getCurrentCompose();
  }
  async openThread(threadId: string) {
    return this.primary.openThread(threadId);
  }
  async archiveThread(threadId: string) {
    return this.primary.archiveThread(threadId);
  }
  async markRead(threadId: string) {
    return this.primary.markRead(threadId);
  }
  async markUnread(threadId: string) {
    return this.primary.markUnread(threadId);
  }
  async starThread(threadId: string) {
    return this.primary.starThread(threadId);
  }
  async createReplyDraft(threadId: string) {
    return this.primary.createReplyDraft(threadId);
  }
  async insertComposeBody(text: string) {
    return this.primary.insertComposeBody(text);
  }
  async navigateToSearch(query: string) {
    return this.primary.navigateToSearch(query);
  }
  async navigateToInbox() {
    return this.primary.navigateToInbox();
  }
}

export * from './types.js';
export * from './capabilities.js';
export * from './events.js';
export * from './selectors.js';
export * from './DomFallbackAdapter.js';
export * from './InboxSdkAdapter.js';
export * from './GmailJsCaptureAdapter.js';
export * from './GmailActionAdapter.js';
export * from './WorkerTabController.js';
export * from './unsubscribe.js';
