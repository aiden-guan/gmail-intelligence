import type { AIProvider, AIJobQueue } from '@gi/ai';
import type { MailboxDatabase } from '@gi/mailbox';
import {
  AgentSafetyTier,
  addBusinessDays,
  detectPlaceholders,
  type ClassificationResult,
  type ExtensionSettings,
} from '@gi/shared';
import {
  applyRules,
  archiveDecision,
  classifyHeuristic,
  type HeuristicInput,
} from './classify.js';

export type AgentLoopDeps = {
  db: MailboxDatabase;
  ai: AIProvider | null;
  queue: AIJobQueue;
  settings: () => ExtensionSettings;
  archiveViaGmail: (threadId: string) => Promise<{ success: boolean; error?: string }>;
  insertDraftViaGmail: (
    threadId: string,
    body: string,
  ) => Promise<{ success: boolean; localOnly?: boolean; error?: string }>;
  log: (entry: {
    type: string;
    threadId?: string;
    detail: string;
    undoable?: boolean;
    tier: number;
    expiresAt?: number;
  }) => Promise<string>;
};

/**
 * Deterministic event-driven agent loop.
 * Each step independently retryable; persist after meaningful steps.
 * Tier 3 actions never autonomous.
 */
export class AgentLoop {
  private lastClassifierRun: number | null = null;

  constructor(private readonly deps: AgentLoopDeps) {}

  getLastClassifierRun(): number | null {
    return this.lastClassifierRun;
  }

  async onNewMessage(input: HeuristicInput & {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string }>;
  }): Promise<void> {
    const settings = this.deps.settings();
    const existing = await this.deps.db.thread_classifications.get(input.threadId);
    if (existing?.fingerprint === input.fingerprint) {
      return; // unchanged — do not re-classify
    }

    // NORMALIZE + RULE ENGINE + CLASSIFY
    const rules = (await this.deps.db.agent_rules.filter((r) => r.enabled).toArray()).map(
      (r) => r.structured,
    );
    let classification: ClassificationResult | null = applyRules(input, rules);
    let source: 'rule' | 'heuristic' | 'ai' = 'rule';

    if (!classification) {
      classification = classifyHeuristic(input);
      source = 'heuristic';
    }

    if (
      !classification ||
      (classification.confidence < 0.7 && settings.aiMode !== 'disabled' && this.deps.ai && settings.autoClassify)
    ) {
      try {
        const aiResult = await this.deps.queue.enqueue('classify', input.fingerprint, () =>
          this.deps.ai!.classifyEmail({
            subject: input.subject,
            snippet: input.snippet,
            bodyText: input.bodyText,
            latestSender: input.latestSenderEmail,
            direction: input.direction,
            gmailCategoryHint: input.gmailCategoryHint,
            hasListUnsubscribe: input.hasListUnsubscribe,
          }),
        );
        // AI must not override explicit user rules
        if (!applyRules(input, rules)) {
          classification = aiResult.result;
          source = 'ai';
        }
      } catch {
        // AI failure must never block — keep heuristic
      }
    }

    if (!classification) {
      classification = {
        category: 'FYI',
        confidence: 0.4,
        priority: 'NORMAL',
        needsReply: false,
        waitingOnReply: false,
        archiveRecommendation: false,
        reason: 'Fallback FYI',
        deadline: null,
      };
      source = 'heuristic';
    }

    this.lastClassifierRun = Date.now();

    await this.deps.db.thread_classifications.put({
      threadId: input.threadId,
      ...classification,
      source,
      fingerprint: input.fingerprint,
      createdAt: Date.now(),
    });

    await this.deps.db.threads.update(input.threadId, {
      classification: classification.category,
      classificationConfidence: classification.confidence,
      priority: classification.priority,
      requiresResponse: classification.needsReply,
      awaitingResponse: classification.waitingOnReply,
      virtualLabels: [classification.category],
    });

    await this.deps.log({
      type: 'classify',
      threadId: input.threadId,
      detail: `${classification.category} (${source}, ${classification.confidence.toFixed(2)}): ${classification.reason}`,
      tier: AgentSafetyTier.READ_ONLY,
    });

    // Branch by category
    if (classification.category === 'RESPOND' && settings.autoSummarize) {
      await this.summarizeIfNeeded(input);
      if (settings.autoDraft && this.deps.ai && settings.aiMode !== 'disabled') {
        await this.draftResponse(input);
      }
    } else if (classification.category === 'WAITING' && settings.autoReminders) {
      await this.trackFollowUp(input);
    } else if (classification.category === 'FYI' && settings.autoSummarize) {
      await this.summarizeIfNeeded(input);
    }

    if (settings.autoArchive) {
      await this.maybeArchive(input, classification, rules);
    }
  }

  async onOutgoing(input: {
    threadId: string;
    recipients: string[];
    subject: string;
    bodyText: string;
    fingerprint: string;
  }): Promise<void> {
    const settings = this.deps.settings();
    // Tracking is handled separately — never block send
    if (settings.autoReminders && settings.reminderMode !== 'disabled') {
      const likelyFollowUp =
        settings.reminderMode === 'every_external' ||
        /(\?|please|let me know|can you|could you|looking forward)/i.test(input.bodyText);

      if (settings.reminderMode === 'every_external' || (settings.reminderMode === 'ai_needed' && likelyFollowUp)) {
        const due = addBusinessDays(new Date(), settings.reminderBusinessDays).getTime();
        await this.deps.db.reminders.put({
          id: `rem_${input.threadId}`,
          threadId: input.threadId,
          recipients: input.recipients,
          lastOutgoingAt: Date.now(),
          dueAt: due,
          status: 'pending',
          reason:
            settings.reminderMode === 'every_external'
              ? 'Outbound follow-up tracking (every external)'
              : 'Outbound may need follow-up',
        });
        await this.deps.log({
          type: 'reminder_created',
          threadId: input.threadId,
          detail: `Follow-up due ${new Date(due).toLocaleDateString()}`,
          tier: AgentSafetyTier.REVERSIBLE,
          undoable: true,
        });
      }
    }
  }

  async resolveReminderOnInbound(threadId: string): Promise<void> {
    const pending = await this.deps.db.reminders.where('threadId').equals(threadId).toArray();
    let resolved = false;
    for (const rem of pending) {
      if (rem.status !== 'pending') continue;
      await this.deps.db.reminders.update(rem.id, { status: 'resolved' });
      resolved = true;
    }
    if (!resolved) return;
    await this.deps.log({
      type: 'reminder_resolved',
      threadId,
      detail: 'Inbound reply received',
      tier: AgentSafetyTier.READ_ONLY,
    });
  }

  private async summarizeIfNeeded(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string }>;
  }): Promise<void> {
    const existing = await this.deps.db.thread_summaries.get(input.threadId);
    if (existing?.fingerprint === input.fingerprint) return;
    if (!this.deps.ai || this.deps.settings().aiMode === 'disabled') return;
    try {
      const { result } = await this.deps.queue.enqueue('summary', input.fingerprint, () =>
        this.deps.ai!.summarizeThread({
          subject: input.subject,
          messages: input.messages,
        }),
      );
      await this.deps.db.thread_summaries.put({
        threadId: input.threadId,
        fingerprint: input.fingerprint,
        summary: result,
        createdAt: Date.now(),
      });
      await this.deps.log({
        type: 'summarize',
        threadId: input.threadId,
        detail: result.oneLine,
        tier: AgentSafetyTier.READ_ONLY,
      });
    } catch {
      /* non-blocking */
    }
  }

  private async draftResponse(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string }>;
  }): Promise<void> {
    const existing = await this.deps.db.draft_suggestions
      .where('threadId')
      .equals(input.threadId)
      .first();
    if (existing?.fingerprint === input.fingerprint) return;
    if (!this.deps.ai) return;
    try {
      const { result } = await this.deps.queue.enqueue('draft', input.fingerprint, () =>
        this.deps.ai!.draftReply({
          subject: input.subject,
          messages: input.messages,
          voice: this.deps.settings().voiceProfile,
          mode: 'direct',
          kind: 'reply',
        }),
      );
      const placeholders = detectPlaceholders(result.body);
      const suggestion = { ...result, placeholders };
      const id = `draft_${input.threadId}_${Date.now()}`;
      await this.deps.db.draft_suggestions.put({
        id,
        threadId: input.threadId,
        fingerprint: input.fingerprint,
        suggestion,
        insertedIntoGmail: false,
        createdAt: Date.now(),
      });

      const inserted = await this.deps.insertDraftViaGmail(input.threadId, suggestion.body);
      if (inserted.success) {
        await this.deps.db.draft_suggestions.update(id, { insertedIntoGmail: true });
      }
      // If Gmail draft creation unreliable, local draft retained — never silently lost
      await this.deps.log({
        type: 'draft',
        threadId: input.threadId,
        detail: inserted.success
          ? 'Draft inserted into Gmail'
          : 'Draft saved locally (Insert Draft available)',
        tier: AgentSafetyTier.DRAFT_WRITE,
        undoable: true,
      });
    } catch {
      /* non-blocking */
    }
  }

  private async trackFollowUp(input: {
    threadId: string;
    latestSenderEmail: string;
  }): Promise<void> {
    const settings = this.deps.settings();
    const due = addBusinessDays(new Date(), settings.reminderBusinessDays).getTime();
    await this.deps.db.reminders.put({
      id: `rem_${input.threadId}`,
      threadId: input.threadId,
      recipients: [input.latestSenderEmail],
      lastOutgoingAt: Date.now(),
      dueAt: due,
      status: 'pending',
      reason: 'Waiting on reply',
    });
  }

  private async maybeArchive(
    input: { threadId: string; latestSenderEmail: string },
    classification: ClassificationResult,
    rules: import('@gi/mailbox').StructuredRule[],
  ): Promise<void> {
    const settings = this.deps.settings();
    const decision = archiveDecision({
      category: classification.category,
      confidence: classification.confidence,
      senderEmail: input.latestSenderEmail,
      archiveCategories: settings.archiveCategories,
      threshold: settings.archiveConfidenceThreshold,
      alwaysArchive: settings.alwaysArchiveSenders,
      neverArchive: settings.neverArchiveSenders,
      rules,
    });

    if (!decision.shouldArchive) return;

    if (!decision.autonomous) {
      await this.deps.log({
        type: 'archive_recommendation',
        threadId: input.threadId,
        detail: decision.reason,
        tier: AgentSafetyTier.REVERSIBLE,
      });
      return;
    }

    // Tier 1 — only if enabled (settings.autoArchive already checked)
    const result = await this.deps.archiveViaGmail(input.threadId);
    if (result.success) {
      await this.deps.db.threads.update(input.threadId, { archivedLocally: true });
      await this.deps.log({
        type: 'archive',
        threadId: input.threadId,
        detail: decision.reason,
        undoable: true,
        tier: AgentSafetyTier.REVERSIBLE,
        expiresAt: Date.now() + 30_000, // short-lived undo
      });
    }
  }
}

export * from './classify.js';
