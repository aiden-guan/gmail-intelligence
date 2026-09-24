export type LocalThreadSummary = {
  reasoning?: string;
  oneLine: string;
  keyPoints: string[];
  decisions: string[];
  unansweredQuestions: string[];
  commitments: string[];
  dates: string[];
  actionItems: string[];
};

const FOOTER =
  /\s+(unsubscribe|view in (your )?browser|view this email online|manage (your )?preferences|privacy policy|you are receiving this|do not reply to this)\b[\s\S]*$/i;
const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b/i;
const SIGN_OFF = /^(best|thanks|thank you|cheers|regards|sincerely|hope to see you|talk soon|warmly)\b/i;
const FILLER = [
  /\b(excited|pleased|delighted|happy) to (share|announce|invite)\b/i,
  /\bopportunity with you\b/i,
  /\bhope to see you\b/i,
  /\bjoin our newsletter\b/i,
  /\bif you(?:'d| would) like to hear\b/i,
  /\binterest form\b/i,
  /\byou can sign up here\b/i,
  /\blearn about the latest\b/i,
  /\bdon't hesitate\b/i,
  /\breach out if\b/i,
  /\bsee what\b.*\b(has to offer|is happening|recwell)\b/i,
  /\bwhat (we have|recwell has) to offer\b/i,
  /\bcheck out\b.*\b(new|latest|offer|what's)\b/i,
  /\bhere(?:'s| is) what(?:'s| is) (new|happening)\b/i,
  /\bin this (issue|edition|newsletter)\b/i,
  /\bread (more|on) below\b/i,
  /\bview (this email|in (your )?browser)\b/i,
];

const MARKETING_PATTERN =
  /\b(?:newsletter|unsubscribe|% off|deal|sale|promo|marketing|view in browser|digest|sponsor|bulletin)\b/i;

const RHETORICAL_QUESTION =
  /\b(?:want|looking for|ready for|interested in|why not|why wait|did you know|have you heard|how about|need a|questions\?|have questions\?)\b/i;

const CONVERSATIONAL_QUESTION =
  /\b(?:can you|could you|would you|will you|are you able|do you have|please let (?:me|us) know|what do you think|any thoughts|should we|how should we|when can you|where should)\b/i;

const MONTH_NAMES =
  /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june|july|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;

const WEEKDAY_NAMES =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

/**
 * A short brief of the text already on screen.
 * Used when a model is off, slow, or only quotes the email back.
 */
export function localThreadSummary(input: {
  subject: string;
  messages: Array<{ bodyText: string }>;
}): LocalThreadSummary {
  const bodies = input.messages.map((message) => cleanMessage(message.bodyText)).filter((text) => text.length > 0);
  const body = bodies.at(-1) || '';
  const subject = input.subject.replace(/\s+/g, ' ').trim();
  const sentences = sentencesFrom(body)
    .map(keepSentence)
    .filter((sentence): sentence is string => Boolean(sentence));
  const useful = sentences.filter((sentence) => !isFiller(sentence));
  const dates = datesIn(`${subject} ${body}`).slice(0, 4);
  const highlight =
    useful.find((sentence) => /\b(free until|until|deadline|due)\b/i.test(sentence)) || useful[0] || '';
  const oneLine = composeLine(subject, highlight, dates);
  const isMarketing = MARKETING_PATTERN.test(`${subject} ${body}`);

  return {
    oneLine,
    keyPoints: extraFacts(body, oneLine),
    decisions: [],
    unansweredQuestions: isMarketing
      ? []
      : useful
          .filter(isMeaningfulQuestion)
          .slice(0, 2)
          .map((sentence) => clip(sentence.replace(/^[.\s…\-_]+/, '').trim(), 120)),
    commitments: [],
    dates,
    actionItems: /\b(sign up|register|rsvp)\b/i.test(body) ? ['Sign up'] : [],
  };
}

/**
 * Drop bullets that quote the email. A pasted one-line is replaced with a real brief.
 */
export function tightenSummary(
  summary: LocalThreadSummary,
  input: { subject: string; messages: Array<{ bodyText: string }> },
): LocalThreadSummary {
  const body = input.messages.map((message) => message.bodyText).join('\n');
  const local = localThreadSummary(input);
  const isMarketing = MARKETING_PATTERN.test(`${input.subject} ${body}`);
  const hasModelLine = Boolean(summary.oneLine?.trim());
  const oneLineIsPasted = !hasModelLine || isRestatement(summary.oneLine, body);
  const oneLine = oneLineIsPasted ? local.oneLine : clip(summary.oneLine, 360);
  const said = oneLine.toLowerCase();

  const keyPoints = unique(
    summary.keyPoints.map((item) => clip(item, 200)).filter((item) => keepPoint(item, body, said)),
  ).slice(0, 4);

  const finalKeyPoints =
    keyPoints.length > 0
      ? keyPoints
      : oneLineIsPasted || summary.keyPoints.length > 0
        ? local.keyPoints
        : [];

  const rawDates = summary.dates.length
    ? summary.dates
    : oneLineIsPasted || summary.dates.length > 0
      ? local.dates
      : [];
  const dates = sanitizeDates(rawDates).slice(0, 4);

  const decisions = isMarketing
    ? []
    : unique(summary.decisions.filter((item) => keepPoint(item, body, said))).slice(0, 3);

  const unansweredQuestions = isMarketing
    ? []
    : unique(
        summary.unansweredQuestions.filter((item) => keepPoint(item, body, said) && isMeaningfulQuestion(item)),
      ).slice(0, 3);

  const commitments = isMarketing
    ? []
    : unique(summary.commitments.filter((item) => keepPoint(item, body, said))).slice(0, 3);

  const actionItems = unique(summary.actionItems.filter((item) => keepPoint(item, body, said))).slice(0, 3);

  return {
    reasoning: summary.reasoning ? clip(summary.reasoning, 1000) : undefined,
    oneLine,
    keyPoints: finalKeyPoints,
    decisions,
    unansweredQuestions,
    commitments,
    dates,
    actionItems,
  };
}

/** True when the text is a greeting or a long stretch copied from the email. */
export function isPastedSummary(oneLine: string, messages: Array<{ bodyText: string }>): boolean {
  return isRestatement(oneLine, messages.map((message) => message.bodyText).join('\n'));
}

function extraFacts(body: string, oneLine: string): string[] {
  const said = oneLine.toLowerCase();
  const facts: string[] = [];
  if ((/\binternships?\b/i.test(body) || /\bnew[- ]grad/i.test(body)) && !/internship|new[- ]grad/i.test(said)) {
    facts.push('Covers internships and new-grad roles.');
  }
  const code = body.match(/\bcode\s+([A-Z0-9-]{3,})\b/i);
  if (code && !said.includes(code[1].toLowerCase())) facts.push(`Use code ${code[1]}.`);
  return facts.slice(0, 2);
}

function composeLine(subject: string, fact: string, dates: string[]): string {
  const subjectBit = /^\(no subject\)$/i.test(subject) ? '' : clip(subject, 90);
  const deadline = deadlinePhrase(fact, dates);
  const factBit = deadline || (fact && !isFiller(fact) ? clip(fact, 120) : '');
  const head = subjectBit.slice(0, 18).toLowerCase();
  if (subjectBit && factBit && head && !factBit.toLowerCase().includes(head)) {
    return clip(`${subjectBit}. ${factBit}`, 200);
  }
  return clip(factBit || subjectBit || 'Empty message', 200);
}

function deadlinePhrase(fact: string, dates: string[]): string {
  if (!fact) return '';
  const part =
    fact
      .split(/(?<=[.!?])\s+/)
      .find((sentence) => dates.some((date) => sentence.toLowerCase().includes(date.toLowerCase()))) || '';
  if (!part || isFiller(part)) return '';
  return clip(part.replace(/\s*you can sign up here\.?/i, '').trim(), 100);
}

function keepPoint(text: string, body: string, said: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 3 || isFiller(clean) || GREETING.test(clean) || SIGN_OFF.test(clean)) return false;
  if (!/[a-zA-Z]{2,}/.test(clean)) return false;
  if (/^[.\s…\-_?]+$/.test(clean)) return false;
  if (isRestatement(clean, body)) return false;
  const head = clean.slice(0, 24).toLowerCase();
  return !head || !said.includes(head);
}

function isRestatement(text: string, body: string): boolean {
  const line = squash(text);
  const source = squash(body);
  if (!line) return false;
  if (GREETING.test(line)) return true;
  if (SIGN_OFF.test(line)) return true;
  if (isFiller(line)) return true;
  if (line.length >= 60 && source.includes(line)) return true;
  const words = line.split(' ').filter(Boolean);
  if (words.length < 18) return false;
  for (let i = 0; i <= words.length - 18; i += 1) {
    if (source.includes(words.slice(i, i + 18).join(' '))) return true;
  }
  return false;
}

function isFiller(sentence: string): boolean {
  return FILLER.some((pattern) => pattern.test(sentence));
}

function isMeaningfulQuestion(sentence: string): boolean {
  if (!sentence.includes('?')) return false;
  const clean = sentence.replace(/[?.\s…\-_]+/g, ' ').trim();
  if (clean.length < 10) return false;
  const words = clean.split(' ').filter(Boolean);
  if (words.length < 3) return false;
  if (!/[a-zA-Z]{2,}/.test(clean)) return false;
  if (RHETORICAL_QUESTION.test(clean)) return false;
  return (
    CONVERSATIONAL_QUESTION.test(clean) ||
    /^(?:what|when|where|who|how|why|which|can|could|would|will|is|are|do|does)\b/i.test(clean)
  );
}

function cleanMessage(text: string): string {
  const separated = text
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const collapsed = separated
    .replace(/\s+/g, ' ')
    .replace(/([,;:])(?=[A-Za-z])/g, '$1 ')
    .replace(/(?<![A-Z])([.!?])(?=[A-Z])/g, '$1 ')
    .trim();
  const withoutQuote = collapsed.split(/\bOn .{0,120}? wrote:/i)[0] || collapsed;
  return withoutQuote.replace(FOOTER, '').trim();
}

function keepSentence(sentence: string): string | null {
  if (SIGN_OFF.test(sentence) || FOOTER.test(` ${sentence}`)) return null;
  const stripped = sentence.replace(/^(hi|hello|hey|dear)\b[^,.!]{0,48}[,.!]\s*/i, '').trim();
  if (!stripped || stripped.length < 12 || GREETING.test(stripped) || SIGN_OFF.test(stripped)) return null;
  return stripped;
}

function sentencesFrom(text: string): string[] {
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

export function datesIn(text: string): string[] {
  const fullDateRegex =
    /\b(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june|july|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi;
  const numericDateRegex = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
  const relativeDateRegex = /\b(?:today|tomorrow)\b/gi;
  const deadlineWeekdayRegex =
    /\b(?:by|due|before|until)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;

  const fullDates = text.match(fullDateRegex) || [];
  const numericDates = text.match(numericDateRegex) || [];
  const relativeDates = text.match(relativeDateRegex) || [];
  const deadlineWeekdays = text.match(deadlineWeekdayRegex) || [];

  const combined = [...fullDates, ...numericDates, ...relativeDates, ...deadlineWeekdays].map((item) =>
    item.trim(),
  );

  return sanitizeDates(combined);
}

export function sanitizeDates(dates: string[]): string[] {
  const cleaned: string[] = [];
  const hasSpecificDate = dates.some(
    (d) => !MONTH_NAMES.test(d.trim()) && !WEEKDAY_NAMES.test(d.trim()),
  );

  for (const date of dates) {
    const trimmed = date.replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length < 2) continue;
    // Discard bare month names (e.g. "September")
    if (MONTH_NAMES.test(trimmed)) continue;
    // Discard bare weekdays if a specific date exists (e.g. drop "Wednesday" if "September 30" exists)
    if (hasSpecificDate && WEEKDAY_NAMES.test(trimmed)) continue;
    cleaned.push(trimmed);
  }

  // Deduplicate and prune subsumed dates (e.g. keep "Wednesday, September 30" and drop "September 30")
  const deduped: string[] = [];
  for (const item of cleaned) {
    const lower = item.toLowerCase();
    const alreadySubsumed = deduped.some((existing) => existing.toLowerCase().includes(lower));
    if (alreadySubsumed) continue;
    // Remove any previously added item that is subsumed by this longer date
    for (let i = deduped.length - 1; i >= 0; i -= 1) {
      if (lower.includes(deduped[i]!.toLowerCase())) {
        deduped.splice(i, 1);
      }
    }
    deduped.push(item);
  }

  return unique(deduped);
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

