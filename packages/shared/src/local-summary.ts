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

const SUPERSEDED_SPLIT =
  /(?:\n\s*)?[-_=*\u2014\u2013]{6,}(?:\s*\n|\s+)|(?:^|\n)\s*(?:previous|earlier)\s+announcement\b|\n\s*(?:begin forwarded message|original message)\b|\bon [\s\S]{0,80}? wrote:\s*/i;

/**
 * Text above a dashed line, "Previous announcement", or quoted reply is the
 * current status. Everything after that is old context.
 */
export function splitSuperseded(text: string): { current: string; older: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = SUPERSEDED_SPLIT.exec(normalized);
  if (!match || match.index == null) return { current: normalized.trim(), older: '' };
  const current = normalized.slice(0, match.index).trim();
  const older = normalized.slice(match.index).trim();
  if (current.length < 20) return { current: normalized.trim(), older: '' };
  return { current, older };
}

/**
 * A short brief of the text already on screen.
 * Used when a model is off, slow, or only quotes the email back.
 */
export function localThreadSummary(input: {
  subject: string;
  messages: Array<{ bodyText: string }>;
}): LocalThreadSummary {
  const latestRaw = input.messages.map((message) => message.bodyText).filter((text) => text.trim()).at(-1) || '';
  const { current } = splitSuperseded(latestRaw);
  const body = cleanMessage(current);
  const subject = currentSubject(input.subject.replace(/\s+/g, ' ').trim(), current);
  const sentences = sentencesFrom(body)
    .map(keepSentence)
    .filter((sentence): sentence is string => Boolean(sentence));
  const useful = sentences.filter((sentence) => !isFiller(sentence) && !isSeparator(sentence));
  const dates = memorableDates(`${subject}\n${body}`);
  const oneLine = composeBrief(subject, useful);
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
  const latestRaw = input.messages.map((message) => message.bodyText).filter((text) => text.trim()).at(-1) || body;
  const { current } = splitSuperseded(latestRaw);
  const local = localThreadSummary(input);
  const isMarketing = MARKETING_PATTERN.test(`${input.subject} ${body}`);
  const hasModelLine = Boolean(summary.oneLine?.trim());
  const oneLineIsPasted =
    !hasModelLine ||
    isBrokenBrief(summary.oneLine) ||
    prefersOlderNotice(summary.oneLine, latestRaw) ||
    contradictsCurrentWeek(summary.oneLine, current) ||
    isRestatement(summary.oneLine, body);
  const oneLine = oneLineIsPasted ? local.oneLine : clip(cleanBrief(summary.oneLine), 360);
  const said = oneLine.toLowerCase();

  const keyPoints = unique(
    summary.keyPoints.map((item) => clip(item, 200)).filter((item) => keepPoint(item, body, said) && !contradictsCurrentWeek(item, current)),
  ).slice(0, 4);

  const finalKeyPoints =
    keyPoints.length > 0
      ? keyPoints
      : oneLineIsPasted || summary.keyPoints.length > 0
        ? local.keyPoints
        : [];

  const dates = chooseDates(summary.dates, local.dates, oneLineIsPasted, current);

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
  const raw = messages.map((message) => message.bodyText).join('\n');
  const latest = messages.map((message) => message.bodyText).filter((text) => text.trim()).at(-1) || raw;
  if (isBrokenBrief(oneLine) || prefersOlderNotice(oneLine, latest)) return true;
  return isRestatement(oneLine, raw);
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

function composeBrief(subject: string, sentences: string[]): string {
  const fact = pickSentences(sentences).map(stripLabel).filter(Boolean).join(' ');
  const subjectBit = /^\(no subject\)$/i.test(subject) ? '' : clip(subject, 90);
  if (fact && subjectBit.length <= 70 && !fact.toLowerCase().includes(subjectBit.toLowerCase())) {
    return clip(`${subjectBit}. ${fact}`, 280);
  }
  return clip(fact || subjectBit || 'Empty message', 280);
}

function pickSentences(sentences: string[]): string[] {
  const scored = sentences.map((sentence, index) => ({ sentence, index, score: scoreSentence(sentence) }));
  const positive = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2);
  const chosen = positive.length ? positive : scored.filter((item) => item.score === 0).slice(0, 1);
  return chosen.sort((a, b) => a.index - b.index).map((item) => item.sentence);
}

function scoreSentence(sentence: string): number {
  if (isSeparator(sentence) || /(?:previous|earlier)\s+announcement/i.test(sentence)) return -5;
  let score = 0;
  if (/\b(update|reopened|available|now|you can)\b/i.test(sentence)) score += 3;
  if (/\b(attached|quiz|assignment|please|request|confirmed|scheduled|submit|review)\b/i.test(sentence)) score += 3;
  if (/\b(deadline|due\s+(?:by|on|date|\d)|until|through|start(?:ing|s)?|begins)\b/i.test(sentence)) score += 2;
  if (/\bdue\s+to\b/i.test(sentence)) score -= 4;
  if (isFiller(sentence)) score -= 3;
  return score;
}

function stripLabel(sentence: string): string {
  return sentence.replace(/^(?:update|announcement|note)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
}

function isSeparator(sentence: string): boolean {
  return /^[-_=*\s]+$/.test(sentence) || /[-_=]{6,}/.test(sentence);
}

function isBrokenBrief(text: string): boolean {
  return /[-_=]{3,}/.test(text) || /\b(?:previous|earlier)\s+announcement\b/i.test(text);
}

function cleanBrief(text: string): string {
  return text
    .replace(/[-_=]{3,}/g, ' ')
    .replace(/\b(?:previous|earlier)\s+announcement\s*:?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function prefersOlderNotice(oneLine: string, raw: string): boolean {
  const { current, older } = splitSuperseded(raw);
  if (!older) return false;
  const lineWords = contentWords(oneLine);
  if (lineWords.length < 4) return false;
  const olderScore = overlapCount(lineWords, contentWords(older));
  const currentScore = overlapCount(lineWords, contentWords(current));
  return olderScore >= 4 && olderScore > currentScore;
}

function contradictsCurrentWeek(text: string, current: string): boolean {
  const currentWeeks = new Set([...current.matchAll(/\bweek\s+(\d+)\b/gi)].map((match) => match[1]));
  return currentWeeks.size > 0 && [...text.matchAll(/\bweek\s+(\d+)\b/gi)].some((match) => !currentWeeks.has(match[1]));
}

function currentSubject(subject: string, current: string): string {
  if (!contradictsCurrentWeek(subject, current)) return subject;
  return subject.replace(/\s+(?:for|in|during|of)\s+week\s+\d+\b/gi, '').replace(/\bweek\s+\d+\b/gi, '').trim();
}

function contentWords(text: string): string[] {
  return squash(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

function overlapCount(left: string[], right: string[]): number {
  const pool = new Set(right);
  return new Set(left.filter((word) => pool.has(word))).size;
}

const STOP_WORDS = new Set([
  'that',
  'this',
  'with',
  'from',
  'have',
  'been',
  'will',
  'your',
  'about',
  'there',
  'their',
  'they',
  'them',
  'were',
  'when',
  'what',
  'into',
  'also',
  'just',
  'than',
]);

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MEMORABLE_CUE =
  /\b(deadline|due\s+(?:by|on|date|\d)|by\s+\d|by\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june|july|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|until|before|through|start(?:ing|s)?|begins|exam|midterm|final|meeting|interview|appointment|rsvp|register|submit)\b/i;

function memorableDates(text: string): string[] {
  const found: string[] = [];
  for (const sentence of sentencesFrom(cleanMessage(text))) {
    if (!MEMORABLE_CUE.test(sentence)) continue;
    if (/\bdue\s+to\b/i.test(sentence) && !/\b(deadline|due\s+(?:by|on|date|\d)|until|before|through|start(?:ing|s)?|begins)\b/i.test(sentence)) {
      continue;
    }
    for (const date of datesIn(sentence)) {
      found.push(labelMemorableDate(sentence, date));
    }
  }
  return unique(found).slice(0, 2);
}

function labelMemorableDate(sentence: string, date: string): string {
  const pretty = prettifyDate(date);
  const week = sentence.match(/\bweek\s+\d+\b/i);
  if (week && /\b(start(?:ing)?|begins)\b/i.test(sentence)) {
    return `${week[0].replace(/\bweek\b/i, 'Week')} starts ${pretty}`;
  }
  if (!isBareNumericDate(date)) return pretty;
  if (/\b(deadline|due)\b/i.test(sentence) && !/\bdue\s+to\b/i.test(sentence)) return `Due ${pretty}`;
  if (/\buntil\b/i.test(sentence)) return `Until ${pretty}`;
  if (/\bthrough\b/i.test(sentence)) return `Through ${pretty}`;
  if (/\bby\b/i.test(sentence)) return `By ${pretty}`;
  return pretty;
}

function prettifyDate(date: string): string {
  const trimmed = date.replace(/\s+/g, ' ').trim();
  const numeric = trimmed.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!numeric) return trimmed;
  const month = Number(numeric[1]);
  const day = Number(numeric[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return trimmed;
  const year = numeric[3] ? `, ${numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]}` : '';
  return `${MONTH_LABELS[month - 1]} ${day}${year}`;
}

function isBareNumericDate(date: string): boolean {
  return /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(date.trim());
}

function chooseDates(
  modelDates: string[],
  localDates: string[],
  oneLineIsPasted: boolean,
  currentText: string,
): string[] {
  if (oneLineIsPasted) return localDates.slice(0, 2);
  if (!modelDates.length) return [];
  if (modelDates.every((date) => isBareNumericDate(date)) && localDates.length) return localDates.slice(0, 2);
  const current = currentText.toLowerCase();
  const kept = sanitizeDates(modelDates)
    .filter((date) => !isBareNumericDate(date) && dateMentioned(date, current))
    .slice(0, 2);
  return kept.length ? kept : localDates.slice(0, 2);
}

function dateMentioned(date: string, currentText: string): boolean {
  const normalized = date.toLowerCase();
  if (currentText.includes(normalized)) return true;
  const words = normalized.split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !DATE_STOP.has(word));
  return words.some((word) => currentText.includes(word));
}

const DATE_STOP = new Set(['due', 'until', 'through', 'starts', 'start', 'week', 'the', 'and']);

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
