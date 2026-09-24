import type { AIProvider, AIJobQueue } from '@gi/ai';
import type { MailboxDatabase } from '@gi/mailbox';
import {
  AgentSafetyTier,
  addBusinessDays,
  detectPlaceholders,
  isPastedSummary,
  localThreadSummary,
  tightenSummary,
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
  onIntel?: (threadId: string, kind: 'THREAD_CLASSIFIED' | 'THREAD_SUMMARY_READY' | 'THREAD_DRAFT_READY' | 'THREAD_INTELLIGENCE_UPDATED') => void;
};

/**
 * Deterministic event-driven agent loop.
 * Each step independently retryable; persist after meaningful steps.
 * Tier 3 actions never autonomous.
 */
export class AgentLoop {
  private lastClassifierRun: number | null = null;
  private summaryAttempts = new Set<string>();

  constructor(private readonly deps: AgentLoopDeps) {}

  getLastClassifierRun(): number | null {
    return this.lastClassifierRun;
  }

  async onNewMessage(input: HeuristicInput & {
    threadId: string;
    fingerprint: string;
    subject: string;
    quality?: 'ROW_STUB' | 'THREAD_PARTIAL' | 'THREAD_COMPLETE';
    messages: Array<{ sender: string; bodyText: string; timestamp: string }>;
  }): Promise<void> {
    const settings = this.deps.settings();
    const quality = input.quality || 'THREAD_PARTIAL';
    const reliable = quality === 'THREAD_COMPLETE';
    const existing = await this.deps.db.thread_classifications.get(input.threadId);
    if (existing?.fingerprint === input.fingerprint) {
      if (hasReadableBody(input.messages) && settings.autoSummarize) await this.summarizeIfNeeded(input);
      return;
    }

    const override = await this.deps.db.thread_overrides.get(input.threadId);
    const rules = (await this.deps.db.agent_rules.filter((r) => r.enabled).toArray()).map(
      (r) => r.structured,
    );
    let classification: ClassificationResult | null = override
      ? null
      : applyRules(input, rules);
    let source: 'rule' | 'heuristic' | 'ai' | 'override' = override ? 'override' : 'rule';

    if (override) {
      const base = classifyHeuristic(input);
      classification = {
        category: override.category,
        confidence: 1,
        priority: base?.priority || 'NORMAL',
        needsReply: override.category === 'RESPOND',
        waitingOnReply: override.category === 'WAITING',
        archiveRecommendation: false,
        reason: 'You set this category',
        deadline: null,
      };
    } else if (!classification) {
      classification = classifyHeuristic(input);
      source = 'heuristic';
    }

    if (
      !override &&
      reliable &&
      (!classification ||
        (classification.confidence < 0.7 && settings.aiMode !== 'disabled' && this.deps.ai && settings.autoClassify))
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
      manualCategory: override ? override.category : undefined,
    });

    await this.deps.log({
      type: 'classify',
      threadId: input.threadId,
      detail: `${classification.category} (${source}, ${classification.confidence.toFixed(2)}): ${classification.reason}`,
      tier: AgentSafetyTier.READ_ONLY,
    });
    this.deps.onIntel?.(input.threadId, 'THREAD_CLASSIFIED');
    this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');

    if (hasReadableBody(input.messages) && settings.autoSummarize) {
      await this.summarizeIfNeeded(input);
    }
    if (!reliable) return;

    if (classification.category === 'RESPOND' && settings.autoDraft && this.deps.ai && settings.aiMode !== 'disabled') {
      await this.draftResponse(input, settings.autoInsertDraft);
    } else if (classification.category === 'WAITING' && settings.autoReminders) {
      await this.trackFollowUp(input);
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
    const fingerprint = `${input.fingerprint}:sum5`;
    const storedLine = existing?.summary.oneLine || '';
    const stalePaste = Boolean(storedLine) && isPastedSummary(storedLine, input.messages);
    if (existing?.fingerprint === fingerprint && existing.source === 'model' && !stalePaste) return;

    const aiReady = Boolean(this.deps.ai) && this.deps.settings().aiMode !== 'disabled';
    const attemptKey = `${input.threadId}:${fingerprint}`;
    if (aiReady && !this.summaryAttempts.has(attemptKey)) {
      this.summaryAttempts.add(attemptKey);
      try {
        const { result } = await this.deps.queue.enqueue('summary', fingerprint, () =>
          this.deps.ai!.summarizeThread({
            subject: input.subject,
            messages: input.messages,
          }),
        );
        const summary = tightenSummary(result, input);
        if (summary.oneLine) {
          await this.deps.db.thread_summaries.put({
            threadId: input.threadId,
            fingerprint,
            summary,
            createdAt: Date.now(),
            source: 'model',
          });
          await this.deps.log({
            type: 'summarize',
            threadId: input.threadId,
            detail: summary.oneLine,
            tier: AgentSafetyTier.READ_ONLY,
          });
          this.deps.onIntel?.(input.threadId, 'THREAD_SUMMARY_READY');
          this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');
          return;
        }
      } catch {
        /* Keep a summary of the text on screen when the model fails. */
      }
    }

    if (existing?.fingerprint === fingerprint && !stalePaste) return;
    const summary = localThreadSummary(input);
    await this.deps.db.thread_summaries.put({
      threadId: input.threadId,
      fingerprint,
      summary,
      createdAt: Date.now(),
      source: 'message',
    });
    await this.deps.log({
      type: 'summarize',
      threadId: input.threadId,
      detail: summary.oneLine,
      tier: AgentSafetyTier.READ_ONLY,
    });
    this.deps.onIntel?.(input.threadId, 'THREAD_SUMMARY_READY');
    this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');
  }

  async requestSummary(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string }>;
  }): Promise<{ ok: boolean; oneLine?: string; reason?: string }> {
    if (!input.messages.some((message) => message.bodyText.trim())) {
      return { ok: false, reason: 'Open the thread so the message can be read.' };
    }
    await this.summarizeIfNeeded(input);
    const summary = await this.deps.db.thread_summaries.get(input.threadId);
    if (!summary) return { ok: false, reason: 'Could not summarize this thread.' };
    return { ok: true, oneLine: summary.summary.oneLine };
  }

  async requestDraft(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string }>;
  }): Promise<{ ok: boolean; body?: string; reason?: string }> {
    if (!this.deps.ai || this.deps.settings().aiMode === 'disabled') {
      return { ok: false, reason: 'Turn on AI in Settings to draft a reply.' };
    }
    if (!input.messages.some((message) => message.bodyText.trim())) {
      return { ok: false, reason: 'Open the thread so a reply can be drafted.' };
    }
    const failure = await this.draftResponse(input, false);
    const drafts = await this.deps.db.draft_suggestions.where('threadId').equals(input.threadId).toArray();
    const draft = drafts.sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!draft?.suggestion.body || (failure && draft.fingerprint !== input.fingerprint)) {
      return { ok: false, reason: failure || 'Could not draft a reply.' };
    }
    return { ok: true, body: draft.suggestion.body };
  }

  private async draftResponse(input: {
    threadId: string;
    fingerprint: string;
    subject: string;
    messages: Array<{ sender: string; bodyText: string; timestamp: string }>;
  }, insertIntoGmail = false): Promise<string | null> {
    const existing = await this.deps.db.draft_suggestions
      .where('threadId')
      .equals(input.threadId)
      .first();
    if (existing?.fingerprint === input.fingerprint) return null;
    if (!this.deps.ai) return 'Turn on AI in Settings to draft a reply.';
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

      let inserted = false;
      if (insertIntoGmail) {
        const result = await this.deps.insertDraftViaGmail(input.threadId, suggestion.body);
        inserted = result.success;
        if (inserted) await this.deps.db.draft_suggestions.update(id, { insertedIntoGmail: true });
      }
      await this.deps.log({
        type: 'draft',
        threadId: input.threadId,
        detail: inserted ? 'Draft inserted into Gmail' : 'Draft saved locally',
        tier: AgentSafetyTier.DRAFT_WRITE,
        undoable: true,
      });
      this.deps.onIntel?.(input.threadId, 'THREAD_DRAFT_READY');
      this.deps.onIntel?.(input.threadId, 'THREAD_INTELLIGENCE_UPDATED');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not draft a reply.';
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

function hasReadableBody(messages: Array<{ bodyText: string }>): boolean {
  return messages.some((message) => message.bodyText.trim().length > 0);
}

export * from './classify.js';
