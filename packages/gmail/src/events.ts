import type { MailboxEvent, MailboxEventHandler } from './types.js';

/** Lightweight typed mailbox event bus. */
export class MailboxEventBus {
  private handlers = new Set<MailboxEventHandler>();
  private lastEvent: MailboxEvent | null = null;

  subscribe(handler: MailboxEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: MailboxEvent): void {
    this.lastEvent = event;
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        console.error('[gi/gmail] event handler error', err);
      }
    }
  }

  getLastEvent(): MailboxEvent | null {
    return this.lastEvent;
  }
}
