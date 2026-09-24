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

  it('handles newsletters cleanly without teaser slogans, bare month tags, or sponsor questions', () => {
    const body = [
      'See What RecWell Has to Offer!',
      'OAKBERRY Want a healthy and delicious grub after a long school day?',
      'Group fitness passes and facility orientations run through Wednesday, September 30.',
      'To unsubscribe from this newsletter, click here.',
    ].join('\n');
    const summary = localThreadSummary({
      subject: 'RecWell September Newsletter',
      messages: [{ bodyText: body }],
    });
    expect(summary.oneLine).not.toMatch(/See What RecWell Has to Offer/i);
    expect(summary.unansweredQuestions).toEqual([]);
    expect(summary.dates).toEqual(['Wednesday, September 30']);
    expect(summary.dates).not.toContain('September');
    expect(summary.dates).not.toContain('Wednesday');
  });

  it('tightenSummary preserves empty dates from model and strips marketing questions', () => {
    const body = 'Check out our latest deals this fall! Want a discount? Unsubscribe here.';
    const modelSummary = {
      oneLine: 'Brand launched their fall collection with discounted items.',
      keyPoints: [],
      decisions: [],
      unansweredQuestions: ['Want a discount?'],
      commitments: [],
      dates: [],
      actionItems: [],
    };
    const tightened = tightenSummary(modelSummary, {
      subject: 'Fall Deals Newsletter',
      messages: [{ bodyText: body }],
    });
    expect(tightened.dates).toEqual([]);
    expect(tightened.unansweredQuestions).toEqual([]);
    expect(tightened.keyPoints).toEqual([]);
  });

  it('preserves model reasoning and synthesized oneLine without false positive restatement rejection', () => {
    const body = [
      'Hi team,',
      'Following up on the auth bug on iOS 17 reported by John earlier today.',
      'We reproduced the issue with expired session tokens.',
      'I will deploy a hotfix to production tomorrow morning at 9am.',
      'Best,',
      'Sarah',
    ].join('\n');
    const modelSummary = {
      reasoning: 'Sarah investigated the iOS 17 auth bug reported by John and will release a hotfix tomorrow at 9am.',
      oneLine: 'Sarah investigated the auth bug on iOS 17 and will deploy a hotfix to production tomorrow at 9am.',
      keyPoints: ['Issue was caused by expired session tokens.'],
      decisions: ['Deploy hotfix to production tomorrow morning.'],
      unansweredQuestions: [],
      commitments: ['Sarah: deploy hotfix tomorrow at 9am'],
      dates: ['Tomorrow at 9am'],
      actionItems: [],
    };
    const tightened = tightenSummary(modelSummary, {
      subject: 'Re: iOS 17 Auth Bug',
      messages: [{ bodyText: body }],
    });
    expect(tightened.reasoning).toMatch(/Sarah investigated the iOS 17 auth bug/);
    expect(tightened.oneLine).toBe(modelSummary.oneLine);
    expect(tightened.keyPoints).toEqual(['Issue was caused by expired session tokens.']);
    expect(tightened.decisions).toEqual(['Deploy hotfix to production tomorrow morning.']);
    expect(tightened.commitments).toEqual(['Sarah: deploy hotfix tomorrow at 9am']);
    expect(isPastedSummary(tightened.oneLine, [{ bodyText: body }])).toBe(false);
  });
});

