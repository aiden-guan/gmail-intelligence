import { describe, expect, it } from 'vitest';
import { SelfViewDeduplicator } from './self-view-dedupe';

describe('SelfViewDeduplicator', () => {
  it('allows MESSAGE_EXPANDED to supersede an earlier ROW_INTERACTION', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    // T = 0: sender pointerdown on row
    expect(dedupe.shouldReport('trk_123', 'msg_1', 0, 'ROW_INTERACTION')).toBe(true);

    // T = 200: duplicate ROW_INTERACTION is suppressed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 200, 'ROW_INTERACTION')).toBe(false);

    // T = 4000: message actually EXPANDS (stronger signal)
    // MUST supersede the earlier ROW_INTERACTION!
    expect(dedupe.shouldReport('trk_123', 'msg_1', 4000, 'MESSAGE_EXPANDED')).toBe(true);

    // T = 4000: repeated MESSAGE_EXPANDED for same observation time is suppressed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 4000, 'MESSAGE_EXPANDED')).toBe(false);

    // T = 5000: a subsequent ROW_INTERACTION cannot override the strong MESSAGE_EXPANDED signal
    expect(dedupe.shouldReport('trk_123', 'msg_1', 5000, 'ROW_INTERACTION')).toBe(false);

    // T = 6000: CACHE_REINSPECTION with same observation timestamp (4000) is suppressed
    expect(dedupe.shouldReport('trk_123', 'msg_1', 4000, 'CACHE_REINSPECTION')).toBe(false);
  });

  it('deduplicates aggressive repeated ROW_INTERACTIONS within 10s', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    expect(dedupe.shouldReport('trk_123', 'msg_1', 1000, 'ROW_INTERACTION')).toBe(true);
    expect(dedupe.shouldReport('trk_123', 'msg_1', 2000, 'ROW_INTERACTION')).toBe(false);
    expect(dedupe.shouldReport('trk_123', 'msg_1', 9000, 'ROW_INTERACTION')).toBe(false);

    // Outside 10s window:
    expect(dedupe.shouldReport('trk_123', 'msg_1', 12000, 'ROW_INTERACTION')).toBe(true);
  });

  it('isolates different tracking IDs and message IDs', () => {
    const dedupe = new SelfViewDeduplicator(10_000);

    expect(dedupe.shouldReport('trk_1', 'msg_1', 1000, 'MESSAGE_EXPANDED')).toBe(true);
    // Different message in same or different tracking ID
    expect(dedupe.shouldReport('trk_1', 'msg_2', 1000, 'MESSAGE_EXPANDED')).toBe(true);
    // Different tracking ID
    expect(dedupe.shouldReport('trk_2', 'msg_1', 1000, 'MESSAGE_EXPANDED')).toBe(true);
  });
});
