import { useState, type CSSProperties } from 'react';
import { categoryLabel } from './chips';

export type ThreadIntelData = {
  classification?: { category?: string; needsReply?: boolean; reason?: string };
  summary?: { summary?: { oneLine?: string; keyPoints?: string[]; actionItems?: string[] } };
  draft?: { suggestion?: { body?: string } };
  manual?: boolean;
};

export function ThreadIntelCard(props: {
  intel?: ThreadIntelData;
  pending?: string | null;
  onDraft: () => void;
  onRemind: () => void;
}) {
  const [open, setOpen] = useState(false);
  const category = categoryLabel(props.intel?.classification?.category);
  const summary = props.intel?.summary?.summary?.oneLine;
  const needsReply = Boolean(props.intel?.classification?.needsReply || props.intel?.draft?.suggestion?.body);
  const points = props.intel?.summary?.summary?.keyPoints || [];
  const actions = props.intel?.summary?.summary?.actionItems || [];

  return (
    <div style={{ font: '13px/1.45 "Google Sans", Roboto, Arial, sans-serif', color: '#202124' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{category || 'Inbox'}</strong>
        {props.intel?.manual ? (
          <span style={{ color: '#5f6368', fontSize: 12 }} title="You set this category">
            Manual
          </span>
        ) : null}
      </div>
      <p style={{ margin: '8px 0 0', color: '#3c4043' }}>
        {summary || props.pending || 'No summary yet.'}
      </p>
      {needsReply ? <div style={{ marginTop: 6, color: '#5f6368' }}>Needs reply</div> : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {needsReply ? (
          <button type="button" onClick={props.onDraft} style={buttonStyle}>
            Draft reply
          </button>
        ) : null}
        <button type="button" onClick={props.onRemind} style={buttonStyle}>
          Remind
        </button>
      </div>
      {points.length || actions.length ? (
        <button type="button" onClick={() => setOpen((value) => !value)} style={{ ...buttonStyle, marginTop: 8 }}>
          {open ? 'Hide details' : 'Details'}
        </button>
      ) : null}
      {open ? (
        <div style={{ marginTop: 8, color: '#3c4043' }}>
          {points.length ? (
            <div>
              <div style={{ color: '#5f6368', marginBottom: 4 }}>Key points</div>
              {points.map((point) => (
                <div key={point}>{point}</div>
              ))}
            </div>
          ) : null}
          {actions.length ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: '#5f6368', marginBottom: 4 }}>Actions</div>
              {actions.map((item) => (
                <div key={item}>{item}</div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const buttonStyle: CSSProperties = {
  border: '1px solid #dadce0',
  background: '#fff',
  borderRadius: 4,
  padding: '4px 8px',
  cursor: 'pointer',
  font: 'inherit',
  color: '#202124',
};
