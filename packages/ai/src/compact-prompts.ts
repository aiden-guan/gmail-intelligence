import type { ChatExample } from './draft-prompt.js';
import type { RewriteInput } from './index.js';

/**
 * Plain-text prompts for small on-device models (0.4B to 1.2B, Gemini Nano).
 * They break JSON often: an unclosed brace at the token cap, a stray comment,
 * or a paragraph instead of an object. Labeled lines cost fewer tokens, so
 * they are faster too, and a partial answer still parses.
 */

export const COMPACT_SUMMARY_SYSTEM_PROMPT = `You summarize an email for the person who received it. Use your own words. Never copy sentences from the email.

Rules:
- Only use facts from this email. Do not reuse anything from earlier examples.
- The latest update is the truth. Text below a dashed line, "Previous announcement", "Earlier announcement", or a quoted reply is old. Do not describe it as still happening.
- Ignore greetings, sign-offs, and marketing filler.
- Do not invent dates, requests, or facts. Write "none" when a line has nothing.

Answer in exactly this format, one line each:
Summary: 1 or 2 plain sentences about what the email means for the reader.
Points: up to 2 extra facts, separated by " | ".
Dates: only deadlines or events to put on a calendar, like "Due Sep 26", separated by " | ".
To do: things the reader should do, separated by " | ".`;

export const COMPACT_SUMMARY_EXAMPLES: ChatExample[] = [
  {
    user: compactSummaryUser(
      'Subject: Water shutoff\n\n--- Message 1 from Building Management ---\nDear residents, water will be off on Tuesday 10/14 from 9am to 1pm for pipe repairs. Please store some water beforehand. Sorry for the trouble.',
    ),
    assistant:
      'Summary: The building is shutting off water for repairs on Tuesday morning.\nPoints: The shutoff lasts from 9am to 1pm\nDates: Water off Oct 14, 9am–1pm\nTo do: Store some water before Tuesday',
  },
  {
    user: compactSummaryUser(
      'Subject: Moving our 1:1\n\n--- Message 1 from Sam Rivera ---\nHey, something came up Thursday. Could we move our 1:1 to Friday at 3? Let me know if that works.',
    ),
    assistant:
      'Summary: Sam wants to move your Thursday 1:1 to Friday at 3 and is waiting for your answer.\nPoints: none\nDates: Proposed 1:1 Friday at 3pm\nTo do: Tell Sam whether Friday at 3 works',
  },
];

export function compactSummaryUser(formattedThread: string): string {
  return `${formattedThread}\n\nSummarize this email.`;
}

type CompactSummary = {
  oneLine: string;
  keyPoints: string[];
  dates: string[];
  actionItems: string[];
};

const SUMMARY_LABELS: Array<[RegExp, keyof CompactSummary]> = [
  [/^(?:summary|one[- ]?line|tl;?dr)$/i, 'oneLine'],
  [/^(?:key )?points?$|^facts?$|^details?$/i, 'keyPoints'],
  [/^(?:key )?dates?$|^deadlines?$/i, 'dates'],
  [/^to[- ]?dos?$|^actions?(?: items?)?$|^next steps?$/i, 'actionItems'],
];

/** Read the labeled summary, or fall back to plain prose as the one-line summary. */
export function parseCompactSummary(text: string): CompactSummary | null {
  const out: CompactSummary = { oneLine: '', keyPoints: [], dates: [], actionItems: [] };
  let field: keyof CompactSummary | null = null;
  let labeled = false;
  const prose: string[] = [];
  for (const raw of stripFences(text).split('\n')) {
    const line = raw.replace(/\*\*/g, '').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z][A-Za-z ;-]{1,20}?)\s*[:：]\s*(.*)$/);
    const key = match ? SUMMARY_LABELS.find(([pattern]) => pattern.test(match[1]!.trim()))?.[1] : undefined;
    if (match && key) {
      field = key;
      labeled = true;
      addValue(out, key, match[2] ?? '');
    } else if (field) {
      addValue(out, field, line);
    } else {
      prose.push(line);
    }
  }
  if (!out.oneLine && prose.length) out.oneLine = prose.join(' ');
  // A long "date" is a sentence the model wrote instead of a date: it would not fit a date chip anyway.
  out.dates = out.dates.filter((date) => date.length <= 40 && !/^(?:no|not)\b/i.test(date));
  if (!out.oneLine && !labeled) return null;
  out.oneLine = firstSentences(out.oneLine, 2);
  return out.oneLine ? out : null;
}

function addValue(out: CompactSummary, key: keyof CompactSummary, value: string): void {
  if (key === 'oneLine') {
    out.oneLine = out.oneLine ? `${out.oneLine} ${value.trim()}` : value.trim();
    return;
  }
  out[key].push(...splitItems(value));
}

function splitItems(value: string): string[] {
  return value
    .split(/\s*[|;]\s*/)
    .map((item) => item.replace(/^["“]|["”]$/g, '').replace(/\.$/, '').trim())
    .filter((item) => item && !/^(?:none|n\/a|no(?:ne)?\.?|nothing|-|\[\])$/i.test(item));
}

function firstSentences(text: string, count: number): string {
  // Split only where a sentence end is followed by a space, so "Rust 2.0" and "$4.99" stay whole.
  return text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).slice(0, count).join(' ');
}

export function compactRewritePrompt(input: RewriteInput, maxChars: number): { system: string; user: string } {
  const task: Record<RewriteInput['mode'], string> = {
    bullets_to_email: 'Turn these notes into a short, clear email.',
    improve: 'Improve the writing. Keep the meaning.',
    shorten: 'Make it shorter. Keep every important point.',
    lengthen: 'Make it a little fuller and warmer. Do not add new facts.',
    simplify: 'Use simpler words and shorter sentences.',
    grammar: 'Fix spelling and grammar only. Change nothing else.',
    rewrite_voice: 'Rewrite it in the user’s own voice.',
    change_tone: `Change the tone to ${input.voice?.formality || 'friendly'}.`,
    draft_follow_up: 'Write a short, polite follow-up based on it.',
    summarize_then_reply: 'Write a short reply that answers it.',
  };
  const text = input.text.length > maxChars ? `${input.text.slice(0, maxChars - 1)}…` : input.text;
  return {
    system: [
      'You edit email text for the user.',
      task[input.mode] || task.improve,
      'Do not invent facts, names, or dates.',
      'Output only the new text. No notes, labels, or quotes.',
    ].join('\n'),
    user: [input.context ? `Context:\n${input.context.slice(0, 600)}\n` : '', `Text:\n"""\n${text}\n"""`]
      .filter(Boolean)
      .join('\n'),
  };
}

export function cleanCompactText(text: string): string {
  return stripFences(text)
    .replace(/^(?:here(?:'s| is) (?:the |your )?(?:rewritten|revised|improved|new|shorter|updated)?\s*(?:text|version|email)?[^:\n]*:\s*)/i, '')
    .replace(/^(?:text|rewritten text|revised)\s*:\s*/i, '')
    .replace(/^"""\s*|\s*"""$/g, '')
    .trim();
}

function stripFences(text: string): string {
  return text.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}
