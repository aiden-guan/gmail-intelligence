export type LocalThreadSummary = {
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

/**
 * A readable summary of the text already on screen.
 * Used when a model is off, slow, or returns something we cannot keep.
 */
export function localThreadSummary(input: {
  subject: string;
  messages: Array<{ bodyText: string }>;
}): LocalThreadSummary {
  const bodies = input.messages.map((message) => cleanMessage(message.bodyText)).filter((text) => text.length > 0);
  const body = bodies.at(-1) || '';
  const sentences = sentencesFrom(body).filter((sentence) => sentence.length > 1 && !FOOTER.test(` ${sentence}`));
  const lead =
    sentences.find((sentence) => sentence.length > 24 && !isGreeting(sentence)) ||
    sentences.map(dropGreeting).find((sentence) => sentence.length > 24) ||
    sentences[0] ||
    body ||
    input.subject.trim();
  const oneLine = clip(lead || 'Empty message', 200);
  const keyPoints = sentences
    .filter((sentence) => sentence !== lead)
    .slice(0, 4)
    .map((sentence) => clip(sentence, 180));
  const questions = sentences.filter((sentence) => sentence.includes('?')).slice(0, 4).map((sentence) => clip(sentence, 180));
  return {
    oneLine,
    keyPoints,
    decisions: [],
    unansweredQuestions: questions,
    commitments: [],
    dates: datesIn(`${input.subject} ${body}`).slice(0, 4),
    actionItems: [],
  };
}

function cleanMessage(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').replace(/([,;:])(?=[A-Za-z])/g, '$1 ').trim();
  const withoutQuote = collapsed.split(/\bOn .{0,120}? wrote:/i)[0] || collapsed;
  return withoutQuote.replace(FOOTER, '').trim();
}

function isGreeting(sentence: string): boolean {
  return /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b/i.test(sentence);
}

function dropGreeting(sentence: string): string {
  return sentence.replace(/^(hi|hello|hey|dear)\b[^,.!]{0,48}[,.!]\s*/i, '').trim();
}

function sentencesFrom(text: string): string[] {
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

function datesIn(text: string): string[] {
  const found = text.match(
    /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june|july|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2})?(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi,
  );
  return [...new Set((found || []).map((item) => item.trim()))];
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}
