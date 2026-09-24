import { normalizeGmailId } from '@gi/tracking';
import type { SelfViewSource } from './message-self-view';

export type SelfViewReport = {
  trackingId: string;
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  observedAt: number;
  source: SelfViewSource;
};

export type ContentSelfViewRecord = {
  observedAt: number;
  source: SelfViewSource;
};

export class SelfViewDeduplicator {
  private recent = new Map<string, ContentSelfViewRecord>();

  constructor(private readonly windowMs = 10_000) {}

  shouldReport(
    trackingId: string,
    gmailMessageId: string | null | undefined,
    observedAt: number,
    source: SelfViewSource,
  ): boolean {
    const normMessageId = normalizeGmailId(gmailMessageId);
    const key = `${trackingId}:${normMessageId || 'unknown'}`;
    const last = this.recent.get(key);

    if (last) {
      // If we already reported a strong signal (MESSAGE_EXPANDED or MESSAGE_LOAD),
      // a subsequent weak ROW_INTERACTION should never override or re-report
      if (source === 'ROW_INTERACTION' && (last.source === 'MESSAGE_EXPANDED' || last.source === 'MESSAGE_LOAD')) {
        return false;
      }

      // If previous was a weak ROW_INTERACTION, the strong MESSAGE_EXPANDED/MESSAGE_LOAD
      // signal MUST be allowed to supersede it!
      if (last.source === 'ROW_INTERACTION' && (source === 'MESSAGE_EXPANDED' || source === 'MESSAGE_LOAD')) {
        this.recent.set(key, { observedAt, source });
        return true;
      }

      // Same observation time (repeated inspection of same view)
      if (observedAt === last.observedAt) {
        return false;
      }

      // Deduplicate within the window
      if (Math.abs(observedAt - last.observedAt) <= this.windowMs) {
        return false;
      }
    }

    this.recent.set(key, { observedAt, source });
    return true;
  }

  clear(): void {
    this.recent.clear();
  }
}
