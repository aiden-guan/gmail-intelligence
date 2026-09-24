import { useState, type MouseEvent } from 'react';
import { categoryLabel } from './chips';

export type IslandMode = 'docked' | 'open' | 'expanded';

export type ThreadIntelData = {
  classification?: { category?: string; needsReply?: boolean; reason?: string };
  summary?: {
    summary?: {
      reasoning?: string;
      oneLine?: string;
      keyPoints?: string[];
      decisions?: string[];
      unansweredQuestions?: string[];
      commitments?: string[];
      dates?: string[];
      actionItems?: string[];
    };
  };
  draft?: { suggestion?: { body?: string } };
  manual?: boolean;
};

export type ThreadTrackingStatus = {
  opened: boolean;
  markLabel: string;
  headline: string;
  detail: string;
  countLabel: string;
};

export function ThreadIntelCard(props: {
  intel?: ThreadIntelData;
  pending?: string | null;
  preview?: string | null;
  tracking?: ThreadTrackingStatus | null;
  mode?: IslandMode;
  variant?: 'float' | 'sidebar';
  onMode?: (mode: IslandMode) => void;
  onDraft: () => void;
  onRemind: () => void;
}) {
  const [uncontrolled, setUncontrolled] = useState<IslandMode>('open');
  const mode = props.mode ?? uncontrolled;
  const category = categoryLabel(props.intel?.classification?.category);
  const isMarketing = /^(promotions|news|notifications)$/i.test(category || '');
  const summary = props.intel?.summary?.summary?.oneLine || props.preview || null;
  const needsReply = Boolean(props.intel?.classification?.needsReply || props.intel?.draft?.suggestion?.body);
  const brief = props.intel?.summary?.summary;
  const reasoning = brief?.reasoning?.trim() || null;
  const points = sanitizeList(brief?.keyPoints || []);
  const dates = sanitizeDateTags(brief?.dates || []);
  const actions = sanitizeList(brief?.actionItems || []);
  const decisions = isMarketing ? [] : sanitizeList(brief?.decisions || []);
  const questions = isMarketing ? [] : sanitizeList(brief?.unansweredQuestions || []);
  const commitments = isMarketing ? [] : sanitizeList(brief?.commitments || []);
  const hasDetails = Boolean(reasoning || actions.length || decisions.length || questions.length || commitments.length);
  const line = summary || props.pending || 'No summary yet.';
  const waiting = !summary && Boolean(props.pending);

  function setMode(next: IslandMode) {
    if (props.mode == null) setUncontrolled(next);
    props.onMode?.(next);
  }

  function keep(event: MouseEvent) {
    event.stopPropagation();
  }

  if (mode === 'docked') {
    return (
      <button
        type="button"
        className="gi-pill"
        aria-expanded="false"
        aria-label="Show intelligence"
        onMouseDown={keep}
        onClick={(event) => {
          keep(event);
          setMode('open');
        }}
      >
        <span className="gi-mark" aria-hidden="true" />
        <span className="gi-pill-label">{category || 'Inbox'}</span>
        <span className={waiting ? 'gi-dot is-live' : needsReply ? 'gi-dot' : 'gi-dot is-quiet'} />
      </button>
    );
  }

  const expanded = mode === 'expanded';

  return (
    <div
      className="gi-shell"
      data-mode={mode}
      data-variant={props.variant || 'float'}
      aria-label="Intelligence"
      onMouseDown={keep}
      onClick={keep}
    >
      <div className="gi-core">
        <div className="gi-bar">
          <div className="gi-brand">
            <span className="gi-mark" aria-hidden="true" />
            <span className="gi-kicker">Intelligence</span>
          </div>
          <button type="button" className="gi-hide" aria-label="Hide intelligence" onClick={() => setMode('docked')}>
            Hide
          </button>
        </div>
        <div className="gi-catrow">
          <div className="gi-cat">{category || 'Inbox'}</div>
          {props.intel?.manual ? <span className="gi-you">Set by you</span> : null}
        </div>
        <p className={waiting ? 'gi-sum is-wait' : 'gi-sum'}>{line}</p>
        {dates.length ? (
          <div className="gi-dates">
            {dates.map((date) => (
              <span className="gi-date" key={date}>
                {date}
              </span>
            ))}
          </div>
        ) : null}
        {points.length ? (
          <ul className="gi-points">
            {points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        ) : null}
        {props.tracking ? (
          <div className="gi-open">
            <div className={props.tracking.opened ? 'gi-open-label is-open' : 'gi-open-label'}>{props.tracking.markLabel}</div>
            <p className="gi-open-line">{props.tracking.headline}</p>
            <p className="gi-open-sub">{props.tracking.detail}</p>
            <div className={props.tracking.opened ? 'gi-open-count is-open' : 'gi-open-count'}>{props.tracking.countLabel}</div>
          </div>
        ) : null}
        <div className="gi-actions">
          {needsReply ? (
            <button type="button" className="gi-action" onClick={props.onDraft}>
              Draft reply
            </button>
          ) : null}
          <button type="button" className={needsReply ? 'gi-action is-ghost' : 'gi-action'} onClick={props.onRemind}>
            Remind
          </button>
          {hasDetails ? (
            <button type="button" className="gi-action is-ghost" onClick={() => setMode(expanded ? 'open' : 'expanded')}>
              {expanded ? 'Hide details' : 'Details'}
            </button>
          ) : null}
        </div>
        {expanded && hasDetails ? (
          <div className="gi-more">
            {reasoning ? (
              <div className="gi-reasoning-block">
                <div className="gi-eyebrow">Reasoning</div>
                <p className="gi-reasoning-text">{reasoning}</p>
              </div>
            ) : null}
            <DetailList title="Decisions" items={decisions} />
            <DetailList title="Open questions" items={questions} />
            <DetailList title="Commitments" items={commitments} />
            <DetailList title="Next steps" items={actions} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
function DetailList(props: { title: string; items: string[] }) {
  const valid = sanitizeList(props.items);
  if (!valid.length) return null;
  return (
    <div>
      <div className="gi-eyebrow">{props.title}</div>
      <ul className="gi-points">
        {valid.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function sanitizeList(items: string[]): string[] {
  return items
    .map((item) => item.replace(/^[•\s\-*–—]+/, '').trim())
    .filter((item) => item.length >= 3 && /[a-zA-Z]{2,}/.test(item) && !/^[.\s…\-_?]+$/.test(item));
}

function sanitizeDateTags(dates: string[]): string[] {
  const MONTHS =
    /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june|july|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
  const WEEKDAYS = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

  const cleaned: string[] = [];
  const hasSpecificDate = dates.some((d) => !MONTHS.test(d.trim()) && !WEEKDAYS.test(d.trim()));

  for (const date of dates) {
    const trimmed = date.replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length < 2) continue;
    if (MONTHS.test(trimmed)) continue;
    if (hasSpecificDate && WEEKDAYS.test(trimmed)) continue;
    cleaned.push(trimmed);
  }

  const deduped: string[] = [];
  for (const item of cleaned) {
    const lower = item.toLowerCase();
    const alreadySubsumed = deduped.some((existing) => existing.toLowerCase().includes(lower));
    if (alreadySubsumed) continue;
    for (let i = deduped.length - 1; i >= 0; i -= 1) {
      if (lower.includes(deduped[i]!.toLowerCase())) {
        deduped.splice(i, 1);
      }
    }
    deduped.push(item);
  }
  return deduped;
}

