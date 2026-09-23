import { useState, type MouseEvent } from 'react';
import { categoryLabel } from './chips';

export type IslandMode = 'docked' | 'open' | 'expanded';

export type ThreadIntelData = {
  classification?: { category?: string; needsReply?: boolean; reason?: string };
  summary?: {
    summary?: {
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
  const summary = props.intel?.summary?.summary?.oneLine || props.preview || null;
  const needsReply = Boolean(props.intel?.classification?.needsReply || props.intel?.draft?.suggestion?.body);
  const brief = props.intel?.summary?.summary;
  const points = brief?.keyPoints || [];
  const dates = brief?.dates || [];
  const actions = brief?.actionItems || [];
  const decisions = brief?.decisions || [];
  const questions = brief?.unansweredQuestions || [];
  const commitments = brief?.commitments || [];
  const hasDetails = Boolean(actions.length || decisions.length || questions.length || commitments.length);
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
  if (!props.items.length) return null;
  return (
    <div>
      <div className="gi-eyebrow">{props.title}</div>
      <ul className="gi-points">
        {props.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
