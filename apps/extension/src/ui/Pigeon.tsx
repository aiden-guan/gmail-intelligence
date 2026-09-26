import type { CSSProperties } from 'react';

export type PigeonState = 'idle' | 'indexing' | 'drafting' | 'opened' | 'error';

/** Four Image Gen frames per state; the atlas is bundled, never remote. */
export function Pigeon({ state = 'idle', size = 88 }: { state?: PigeonState; size?: number }) {
  const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('brand/pigeon-states.png')
    : '/brand/pigeon-states.png';
  return <span aria-hidden="true" className="gi-pigeon" data-state={state}
    style={{ fontSize: size, backgroundImage: `url("${url}")` } as CSSProperties} />;
}

export function Brand() {
  return <div className="gi-brand-lockup"><Pigeon size={38} /><span>PigeonBox<span className="gi-brand-sub">Your inbox, a little lighter.</span></span></div>;
}
