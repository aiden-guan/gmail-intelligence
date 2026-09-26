const BANDS = [
  'M26.97,2.42L37.03,2.42A30,30 0 0,1 44.09,4.55L19.91,4.55A30,30 0 0,1 26.97,2.42Z',
  'M18.14,5.4L45.86,5.4A30,30 0 0,1 55.11,12.87L8.89,12.87A30,30 0 0,1 18.14,5.4Z',
  'M8.21,13.72L55.79,13.72A30,30 0 0,1 61.15,24.9L2.85,24.9A30,30 0 0,1 8.21,13.72Z',
  'M2.66,25.75L61.34,25.75A30,30 0 0,1 61.34,38.25L2.66,38.25A30,30 0 0,1 2.66,25.75Z',
  'M2.85,39.1L61.15,39.1A30,30 0 0,1 55.79,50.28L8.21,50.28A30,30 0 0,1 2.85,39.1Z',
  'M8.89,51.13L55.11,51.13A30,30 0 0,1 45.86,58.6L18.14,58.6A30,30 0 0,1 8.89,51.13Z',
  'M19.91,59.45L44.09,59.45A30,30 0 0,1 37.03,61.58L26.97,61.58A30,30 0 0,1 19.91,59.45Z',
];

let nextId = 0;

/** SVG for the loading orb. Gradient ids are unique per call so orbs never share defs. */
export function orbSvg(): string {
  const id = `gi-orb-${nextId++}`;
  const bands = BANDS.map((d, i) => `<path class="gi-orb-band" d="${d}" style="--i:${i}"/>`).join('');
  return `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">`
    + `<defs>`
    + `<radialGradient id="${id}-hi" cx="30%" cy="18%" r="70%"><stop class="gi-orb-lit" offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="${id}-lo" cx="74%" cy="92%" r="78%"><stop class="gi-orb-shade" offset="0%" stop-color="#000"/><stop offset="100%" stop-color="#000" stop-opacity="0"/></radialGradient>`
    + `</defs>`
    + `<circle class="gi-orb-ground" cx="32" cy="32" r="30"/>`
    + `<g class="gi-orb-shell">${bands}</g>`
    + `<circle cx="32" cy="32" r="30" fill="url(#${id}-lo)"/>`
    + `<circle cx="32" cy="32" r="30" fill="url(#${id}-hi)"/>`
    + `<circle class="gi-orb-rim" cx="32" cy="32" r="30"/>`
    + `</svg>`;
}

export type OrbTone = 'paper' | 'bare' | 'on-accent';

export function orbClass(tone: OrbTone = 'paper'): string {
  return tone === 'paper' ? 'gi-orb' : `gi-orb is-${tone}`;
}

/** Plain-DOM orb for surfaces that are not rendered by React (toasts). */
export function createOrb(size = 16, tone: OrbTone = 'paper'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = orbClass(tone);
  span.style.fontSize = `${size}px`;
  span.innerHTML = orbSvg();
  return span;
}
