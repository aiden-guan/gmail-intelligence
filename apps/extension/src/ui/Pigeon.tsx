import type { CSSProperties } from 'react';

export type PigeonState = 'idle' | 'indexing' | 'drafting' | 'opened' | 'error';

// Measured atlas windows, with a common foot baseline and body center.
// The generated sheet is not a regular grid.
const frames: Record<PigeonState, { top: number; bottom: number; centers: number[] }> = {
  idle: { top: 40, bottom: 294, centers: [195, 490, 790, 1080] },
  indexing: { top: 315, bottom: 530, centers: [220, 515, 810, 1100] },
  drafting: { top: 545, bottom: 768, centers: [185, 480, 780, 1075] },
  opened: { top: 780, bottom: 1000, centers: [185, 480, 780, 1075] },
  error: { top: 1010, bottom: 1236, centers: [190, 485, 785, 1080] },
};
export function Pigeon({ state = 'idle', size = 88 }: { state?: PigeonState; size?: number }) {
  const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('brand/pigeon-states.png')
    : '/brand/pigeon-states.png';
  const row = frames[state];
  return <span aria-hidden="true" className="gi-pigeon" data-state={state}
    style={{ fontSize: size } as CSSProperties}>
    {row.centers.map((center, index) => <span key={index} className="gi-pigeon-frame" style={{
      '--frame': index,
      height: `${(row.bottom - row.top) / 320}em`,
      backgroundImage: `url("${url}")`,
      backgroundPosition: `${-(center - 150) / 320}em ${-row.top / 320}em`,
    } as CSSProperties} />)}
  </span>;
}

export function Brand() {
  return <div className="gi-brand-lockup"><Pigeon size={38} /><span>PigeonBox<span className="gi-brand-sub">Your inbox, a little lighter.</span></span></div>;
}
