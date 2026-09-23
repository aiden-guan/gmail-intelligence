import { describe, expect, it } from 'vitest';
import { localThreadSummary } from './local-summary.js';

describe('local thread summary', () => {
  it('skips a greeting and keeps the point of the email', () => {
    const summary = localThreadSummary({
      subject: 'Berkeley China Summit',
      messages: [
        {
          bodyText: "Hi all,We're ACA (Asian-American Collegiate Alliance), and we're excited to share the Berkeley China Summit.",
        },
      ],
    });
    expect(summary.oneLine.startsWith('Hi')).toBe(false);
    expect(summary.oneLine).toMatch(/Berkeley China Summit/);
    expect(summary.oneLine).toMatch(/,\s/);
  });
});
