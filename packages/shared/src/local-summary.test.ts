import { describe, expect, it } from 'vitest';
import { isPastedSummary, localThreadSummary, tightenSummary } from './local-summary.js';

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
    expect(summary.oneLine).not.toMatch(/excited to share/);
  });

  it('turns a promo into a subject plus the deadline, not the greeting', () => {
    const body = [
      'Hi all,',
      "We're ACA (Asian-American Collegiate Alliance), and we're excited to share an opportunity with you: the Berkeley China Summit (BCS), in partnership with TikTok Recruiting.",
      "At BCS, you'll get to learn about the latest in AI and tech and connect directly with TikTok's recruiting teams about internships and new grad roles.",
      'Student registration is free until September 26. You can sign up here.',
      'Hope to see you there!',
      'Best,',
      'ACA Execs',
    ].join('\n');
    const summary = localThreadSummary({
      subject: 'Berkeley China Summit with TikTok Recruiting (Sign Up by 9/26)',
      messages: [{ bodyText: body }],
    });
    expect(summary.oneLine.startsWith('Hi')).toBe(false);
    expect(summary.oneLine.startsWith("We're")).toBe(false);
    expect(summary.oneLine).toMatch(/Berkeley China Summit/);
    expect(summary.oneLine).toMatch(/September 26/);
    expect(summary.keyPoints.join(' ')).toMatch(/internship/i);
    expect(summary.keyPoints.join(' ')).not.toMatch(/We're ACA|At BCS|sign up here|newsletter|Hope to see/);
    expect(summary.actionItems).toEqual(['Sign up']);
    expect(isPastedSummary(summary.oneLine, [{ bodyText: body }])).toBe(false);
    expect(isPastedSummary("Hi all, We're ACA and we're excited to share an opportunity with you today.", [{ bodyText: body }])).toBe(true);
  });

  it('drops bullets that quote the email and keeps one new fact', () => {
    const body = [
      "We're ACA (Asian-American Collegiate Alliance), and we're excited to share an opportunity with you: the Berkeley China Summit (BCS), in partnership with TikTok Recruiting.",
      "At BCS, you'll get to learn about the latest in AI and tech and connect directly with TikTok's recruiting teams about internships and new grad roles.",
      'You can sign up here.',
      "If you'd like to hear about more events like this, please fill out our interest form to join our newsletter: Hope to see you there!",
    ].join(' ');
    const summary = tightenSummary(
      {
        oneLine: "We're ACA (Asian-American Collegiate Alliance), and we're excited to share an opportunity with you: the Berkeley China Summit (BCS), in partnership with TikTok Recruiting.",
        keyPoints: [
          "At BCS, you'll get to learn about the latest in AI and tech and connect directly with TikTok's recruiting teams about internships and new grad roles.",
          'You can sign up here.',
          "If you'd like to hear about more events like this, please fill out our interest form to join our newsletter.",
        ],
        decisions: [],
        unansweredQuestions: [],
        commitments: [],
        dates: [],
        actionItems: ['You can sign up here.'],
      },
      {
        subject: 'Berkeley China Summit with TikTok Recruiting (Sign Up by 9/26)',
        messages: [{ bodyText: body }],
      },
    );
    expect(summary.oneLine.startsWith("We're")).toBe(false);
    expect(summary.oneLine).toMatch(/Berkeley China Summit/);
    expect(summary.keyPoints.join(' ')).not.toMatch(/At BCS|sign up here|newsletter/);
    expect(summary.keyPoints.join(' ')).toMatch(/internship/i);
    expect(summary.actionItems).toEqual([]);
  });
});
