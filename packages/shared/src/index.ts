import { z } from 'zod';

/** Inbox intelligence categories — product definitions. */
export const ThreadCategorySchema = z.enum([
  'RESPOND',
  'WAITING',
  'FYI',
  'NOTIFICATIONS',
  'PROMOTIONS',
  'NEWS',
]);
export type ThreadCategory = z.infer<typeof ThreadCategorySchema>;

export const PrioritySchema = z.enum(['HIGH', 'NORMAL', 'LOW']);
export type Priority = z.infer<typeof PrioritySchema>;

export const AgentSafetyTier = {
  READ_ONLY: 0,
  REVERSIBLE: 1,
  DRAFT_WRITE: 2,
  DESTRUCTIVE: 3,
} as const;
export type AgentSafetyTierLevel = (typeof AgentSafetyTier)[keyof typeof AgentSafetyTier];

export const ClassificationResultSchema = z.object({
  category: ThreadCategorySchema,
  confidence: z.number().min(0).max(1),
  priority: PrioritySchema,
  needsReply: z.boolean(),
  waitingOnReply: z.boolean(),
  archiveRecommendation: z.boolean(),
  reason: z.string().max(500),
  deadline: z.string().nullable().optional(),
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export const NeedsReplyResultSchema = z.object({
  needsReply: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
});
export type NeedsReplyResult = z.infer<typeof NeedsReplyResultSchema>;

export const ThreadSummarySchema = z.object({
  oneLine: z.string().max(280),
  keyPoints: z.array(z.string()).max(12),
  decisions: z.array(z.string()).max(8),
  unansweredQuestions: z.array(z.string()).max(8),
  commitments: z.array(z.string()).max(8),
  dates: z.array(z.string()).max(8),
  actionItems: z.array(z.string()).max(12),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const DraftSuggestionSchema = z.object({
  mode: z.enum(['direct', 'warm', 'short']).default('direct'),
  subject: z.string().optional(),
  body: z.string().min(1),
  placeholders: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
});
export type DraftSuggestion = {
  mode: 'direct' | 'warm' | 'short';
  subject?: string;
  body: string;
  placeholders: string[];
  confidence?: number;
};

export const ContactSchema = z.object({
  email: z.string().email().or(z.string().min(1)),
  name: z.string().optional(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const AttachmentMetaSchema = z.object({
  filename: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

export type GmailActionResult = {
  success: boolean;
  capability: string;
  error?: string;
  retryable?: boolean;
};

export type GmailCapabilities = {
  inboxSdkAvailable: boolean;
  gmailJsCaptureAvailable: boolean;
  backgroundWorkerTabAvailable: boolean;
  persistentNativeLabelMutationAvailable: boolean;
  domFallbackAvailable: boolean;
};

export const PLACEHOLDER_PATTERN =
  /\[(DATE|TIME|LINK|NAME|ATTACHMENT|AMOUNT)\]/gi;

export function detectPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_PATTERN)) {
    found.add(`[${m[1]!.toUpperCase()}]`);
  }
  return [...found];
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sanitize email HTML for safe display in extension React UI (never raw). */
export function sanitizeEmailHtml(html: string): string {
  const withoutDangerous = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:text\/html/gi, '');
  // Prefer plaintext for React UI; return escaped fragment if needed
  return stripHtml(withoutDangerous);
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function contentFingerprint(parts: {
  gmailThreadId: string;
  latestMessageId: string;
  latestTimestamp: string;
  normalizedBodyHash: string;
}): Promise<string> {
  return sha256Hex(
    `${parts.gmailThreadId}|${parts.latestMessageId}|${parts.latestTimestamp}|${parts.normalizedBodyHash}`,
  );
}

export async function hashBody(text: string): Promise<string> {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return sha256Hex(normalized);
}

export const BridgeMessageSchema = z.object({
  source: z.literal('gi-main-world'),
  type: z.string().min(1).max(64),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
  ts: z.number().optional(),
});
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

export const RuntimeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PING') }),
  z.object({ type: z.literal('GET_SETTINGS') }),
  z.object({
    type: z.literal('SAVE_SETTINGS'),
    settings: z.record(z.unknown()),
  }),
  z.object({ type: z.literal('RUN_DIAGNOSTICS') }),
  z.object({
    type: z.literal('GMAIL_EVENT'),
    event: z.string(),
    payload: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('ENQUEUE_ACTION'),
    action: z.string(),
    args: z.record(z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('ASK_INBOX'),
    query: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal('INDEX_INBOX'),
    mode: z.enum(['7d', '30d', '90d', '1y', 'custom', 'sent_sample']),
    customQuery: z.string().optional(),
  }),
  z.object({ type: z.literal('PAUSE_INDEX') }),
  z.object({ type: z.literal('RESUME_INDEX') }),
  z.object({ type: z.literal('CLEAR_INDEX') }),
  z.object({ type: z.literal('CLEAR_AI_CACHE') }),
  z.object({ type: z.literal('GET_ACTIVITY_LOG') }),
  z.object({
    type: z.literal('UNDO_ACTION'),
    actionId: z.string(),
  }),
  z.object({
    type: z.literal('TRACKING_POLL'),
  }),
  z.object({
    type: z.literal('WRITE_WITH_AI'),
    mode: z.string(),
    text: z.string(),
    context: z.string().optional(),
  }),
]);
export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;

export type AiProcessingMode = 'disabled' | 'remote' | 'local';

export type ExtensionSettings = {
  trackingEnabled: boolean;
  trackOpens: boolean;
  trackLinks: boolean;
  desktopNotifications: boolean;
  hideSuspectedSelfOpens: boolean;
  trackerBaseUrl: string;
  personalApiToken: string;
  aiMode: AiProcessingMode;
  aiProvider: 'openai' | 'anthropic' | 'gemini' | 'openai-compatible' | 'ollama';
  aiModel: string;
  aiEndpoint: string;
  aiApiKey: string;
  autoClassify: boolean;
  autoSummarize: boolean;
  autoDraft: boolean;
  autoReminders: boolean;
  autoArchive: boolean;
  archiveCategories: ThreadCategory[];
  archiveConfidenceThreshold: number;
  alwaysArchiveSenders: string[];
  neverArchiveSenders: string[];
  reminderMode: 'ai_needed' | 'every_external' | 'disabled';
  reminderBusinessDays: number;
  commandPaletteEnabled: boolean;
  commandPaletteOverrideGmail: boolean;
  inboxSdkAppId: string;
  voiceProfile: VoiceProfile;
  learnFromSent: boolean;
};

export type VoiceProfile = {
  greeting: string;
  signoff: string;
  concision: 'short' | 'medium' | 'long';
  capitalization: 'normal' | 'sentence' | 'title';
  formality: 'casual' | 'neutral' | 'formal';
  emoji: boolean;
  schedulingPreference: string;
  personalInstructions: string;
};

export const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  greeting: 'Hi',
  signoff: 'Thanks',
  concision: 'medium',
  capitalization: 'normal',
  formality: 'neutral',
  emoji: false,
  schedulingPreference: '',
  personalInstructions: '',
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  trackingEnabled: true,
  trackOpens: true,
  trackLinks: true,
  desktopNotifications: true,
  hideSuspectedSelfOpens: true,
  trackerBaseUrl: '',
  personalApiToken: '',
  aiMode: 'disabled',
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiEndpoint: 'https://api.openai.com/v1',
  aiApiKey: '',
  autoClassify: true,
  autoSummarize: true,
  autoDraft: false,
  autoReminders: true,
  autoArchive: false,
  archiveCategories: ['NOTIFICATIONS', 'PROMOTIONS', 'NEWS'],
  archiveConfidenceThreshold: 0.95,
  alwaysArchiveSenders: [],
  neverArchiveSenders: [],
  reminderMode: 'ai_needed',
  reminderBusinessDays: 3,
  commandPaletteEnabled: true,
  commandPaletteOverrideGmail: false,
  inboxSdkAppId: '',
  voiceProfile: DEFAULT_VOICE_PROFILE,
  learnFromSent: false,
};

export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return d;
}
