import {
  describeTrackingStatus,
  matchTrackedEmail,
  type TrackedEmailSummary,
  type TrackingRowQuery,
} from '@gi/tracking';

export type SentStatusController = {
  setEmails(emails: TrackedEmailSummary[]): void;
  setTrackerBaseUrl(url: string): void;
  paint(): void;
  destroy(): void;
};

const ROW_SELECTOR = 'tr.zA, tr[data-legacy-thread-id], div[role="listitem"][data-legacy-thread-id]';

export function installSentStatus(opts: {
  emails?: TrackedEmailSummary[];
  trackerBaseUrl?: string;
  onNotify: (trackingId: string, enabled: boolean) => void;
}): SentStatusController {
  let emails = opts.emails || [];
  let trackerBaseUrl = opts.trackerBaseUrl || '';
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  ensureStyles();
  setTrackerBaseAttribute(trackerBaseUrl);

  const paint = () => paintRows(document, emails, trackerBaseUrl, opts.onNotify);
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(paint, 120);
  };

  if (document.body) {
    observer = new MutationObserver((mutations) => {
      const own = mutations.every((mutation) => {
        const node = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return Boolean(node?.closest('.gi-track-slot, .gi-track-card, .gi-track-backdrop, #gi-track-style'));
      });
      if (!own) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    paint();
  }

  return {
    setEmails(next) {
      emails = next;
      paint();
    },
    setTrackerBaseUrl(url) {
      trackerBaseUrl = url;
      setTrackerBaseAttribute(url);
      paint();
    },
    paint,
    destroy() {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      closeCard();
    },
  };
}

export function readRowQuery(row: Element): TrackingRowQuery {
  const threadIds = collectThreadIds(row);
  const subject =
    row.querySelector('.bog')?.textContent?.trim() ||
    row.querySelector('.y6 span')?.textContent?.trim() ||
    '';
  const emails = [...row.querySelectorAll('[email]')]
    .map((node) => node.getAttribute('email') || '')
    .filter((email) => email.includes('@'));
  return { threadIds, subject, emails };
}

export function paintRows(
  root: ParentNode,
  emails: TrackedEmailSummary[],
  trackerBaseUrl: string,
  onNotify: (trackingId: string, enabled: boolean) => void,
): void {
  ensureStyles();
  const rows = root.querySelectorAll?.(ROW_SELECTOR) || [];
  rows.forEach((row) => {
    if (!(row instanceof HTMLElement)) return;
    if (row.closest('[data-gi-ui="track-card"]')) return;
    const match = matchTrackedEmail(readRowQuery(row), emails);
    const existing = row.querySelector('.gi-track-slot');
    if (!match) {
      existing?.remove();
      if (row.dataset.giTracked) delete row.dataset.giTracked;
      return;
    }
    const slot = existing instanceof HTMLElement ? existing : createSlot(row);
    const copy = describeTrackingStatus(match, { trackerBaseUrl });
    const signature = `${match.trackingId}:${copy.opened}:${copy.countLabel}:${match.notifyIfNoReply}:${trackerBaseUrl}`;
    if (slot.dataset.signature === signature && slot.querySelector('.gi-track-btn')) {
      row.dataset.giTracked = copy.opened ? 'opened' : 'pending';
      return;
    }
    slot.dataset.signature = signature;
    slot.replaceChildren(renderButton(match, copy, trackerBaseUrl, onNotify));
    row.dataset.giTracked = copy.opened ? 'opened' : 'pending';
  });
}

function collectThreadIds(row: Element): string[] {
  const ids = new Set<string>();
  const attrs = ['data-gi-thread-id', 'data-legacy-thread-id', 'data-thread-id', 'data-thread-perm-id'];
  const nodes = [
    row,
    ...row.querySelectorAll('[data-gi-thread-id], [data-legacy-thread-id], [data-thread-id], [data-thread-perm-id]'),
  ];
  for (const node of nodes) {
    for (const attr of attrs) {
      const value = node.getAttribute(attr);
      if (value) ids.add(value);
    }
  }
  return [...ids];
}

function createSlot(row: HTMLElement): HTMLElement {
  const slot = document.createElement('span');
  slot.className = 'gi-track-slot';
  slot.setAttribute('data-gi-ui', 'track');
  const host = row.querySelector('.yW') || row.querySelector('td.yX') || row;
  host.insertBefore(slot, host.firstChild);
  return slot;
}

function renderButton(
  email: TrackedEmailSummary,
  copy: ReturnType<typeof describeTrackingStatus>,
  trackerBaseUrl: string,
  onNotify: (trackingId: string, enabled: boolean) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'gi-track-btn';
  button.dataset.state = copy.opened ? 'opened' : 'pending';
  button.dataset.trackingId = email.trackingId;
  button.dataset.trackerBase = trackerBaseUrl;
  button.setAttribute('aria-label', copy.headline);
  button.title = copy.countLabel;
  button.innerHTML = copy.opened ? DOUBLE_CHECK : SINGLE_CHECK;
  button.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  button.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleCard(button, email, onNotify);
  });
  return button;
}

let openCard: HTMLElement | null = null;
let openBackdrop: HTMLElement | null = null;
let openTrackingId: string | null = null;

function toggleCard(
  anchor: HTMLButtonElement,
  email: TrackedEmailSummary,
  onNotify: (trackingId: string, enabled: boolean) => void,
): void {
  if (!openCard?.isConnected) {
    openCard = null;
    openBackdrop = null;
    openTrackingId = null;
  }
  if (openTrackingId === email.trackingId) {
    closeCard();
    anchor.focus();
    return;
  }
  closeCard();
  const card = renderCard(email, anchor, onNotify);
  const backdrop = document.createElement('div');
  backdrop.className = 'gi-track-backdrop';
  backdrop.setAttribute('data-gi-ui', 'track-backdrop');
  backdrop.addEventListener('click', () => {
    closeCard();
    anchor.focus();
  });
  document.body.append(backdrop, card);
  placeCard(card, anchor);
  openCard = card;
  openBackdrop = backdrop;
  openTrackingId = email.trackingId;
  card.querySelector<HTMLElement>('[role="switch"]')?.focus();
}

function renderCard(
  email: TrackedEmailSummary,
  anchor: HTMLButtonElement,
  onNotify: (trackingId: string, enabled: boolean) => void,
): HTMLElement {
  const copy = describeTrackingStatus(email, {
    trackerBaseUrl: anchor.dataset.trackerBase || readTrackerBase(anchor),
  });
  const card = document.createElement('div');
  card.className = 'gi-track-card';
  card.setAttribute('data-gi-ui', 'track-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Email open status');
  card.tabIndex = -1;

  const headline = document.createElement('p');
  headline.className = 'gi-track-headline';
  if (copy.emphasis) {
    const strong = document.createElement('strong');
    strong.textContent = copy.emphasis;
    headline.append(strong, document.createTextNode(copy.rest));
  } else {
    headline.textContent = copy.headline;
  }

  const detail = document.createElement('p');
  detail.className = 'gi-track-detail';
  detail.innerHTML = EYE_ICON;
  const detailText = document.createElement('span');
  detailText.textContent = copy.detail;
  detail.append(detailText);

  const count = document.createElement('div');
  count.className = copy.opened ? 'gi-track-count is-open' : 'gi-track-count';
  count.textContent = copy.countLabel;

  const footer = document.createElement('div');
  footer.className = 'gi-track-footer';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'gi-switch';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', email.notifyIfNoReply ? 'true' : 'false');
  toggle.setAttribute('aria-label', 'Notify me if there is no reply');
  const knob = document.createElement('span');
  knob.className = 'gi-switch-knob';
  toggle.append(knob);
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', next ? 'true' : 'false');
    email.notifyIfNoReply = next;
    onNotify(email.trackingId, next);
  });
  const label = document.createElement('span');
  label.className = 'gi-track-notify';
  label.textContent = 'Notify me if there is no reply';
  footer.append(toggle, label);

  const arrow = document.createElement('span');
  arrow.className = 'gi-track-arrow';
  arrow.setAttribute('aria-hidden', 'true');

  card.append(headline, detail, count);
  if (copy.loopbackWarning) {
    const warning = document.createElement('p');
    warning.className = 'gi-track-warning';
    warning.textContent = copy.loopbackWarning;
    card.append(warning);
  }
  card.append(footer, arrow);

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeCard();
    anchor.focus();
  };
  card.addEventListener('keydown', onKey);
  return card;
}

function readTrackerBase(anchor: HTMLElement): string {
  return anchor.ownerDocument.documentElement.getAttribute('data-gi-tracker-base') || '';
}

export function setTrackerBaseAttribute(url: string): void {
  document.documentElement.setAttribute('data-gi-tracker-base', url);
}

function placeCard(card: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = 340;
  const margin = 8;
  card.style.width = `${width}px`;
  const height = card.offsetHeight || 180;
  let top = rect.top - height - 12;
  let placement: 'above' | 'below' = 'above';
  if (top < margin) {
    top = rect.bottom + 12;
    placement = 'below';
  }
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  card.style.top = `${Math.max(margin, top)}px`;
  card.style.left = `${left}px`;
  card.dataset.placement = placement;
  const arrow = card.querySelector<HTMLElement>('.gi-track-arrow');
  if (arrow) {
    const anchorCenter = rect.left + rect.width / 2;
    arrow.style.left = `${Math.max(18, Math.min(width - 18, anchorCenter - left))}px`;
  }
}

function closeCard(): void {
  openCard?.remove();
  openBackdrop?.remove();
  openCard = null;
  openBackdrop = null;
  openTrackingId = null;
}

function ensureStyles(): void {
  if (document.getElementById('gi-track-style')) return;
  const style = document.createElement('style');
  style.id = 'gi-track-style';
  style.textContent = `
    .gi-track-slot { display: inline-flex; align-items: center; margin-right: 6px; vertical-align: middle; flex: 0 0 auto; }
    .gi-track-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; background: transparent; color: #9aa0a6; cursor: pointer; border-radius: 4px; }
    .gi-track-btn[data-state="opened"] { color: #188038; }
    .gi-track-btn:hover { background: rgba(128, 134, 139, 0.16); }
    .gi-track-backdrop { position: fixed; inset: 0; z-index: 2147483645; background: transparent; }
    .gi-track-card { position: fixed; z-index: 2147483646; box-sizing: border-box; width: 340px; padding: 16px 16px 12px; background: #fff; color: #202124; border-radius: 8px; box-shadow: 0 8px 28px rgba(32, 33, 36, 0.28); font: 14px/1.4 "Google Sans", Roboto, Arial, sans-serif; }
    .gi-track-headline { margin: 0; color: #202124; }
    .gi-track-headline strong { font-weight: 600; }
    .gi-track-detail { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0 0; color: #5f6368; font-size: 13px; }
    .gi-track-detail svg { flex: 0 0 auto; margin-top: 1px; }
    .gi-track-count { margin-top: 14px; border-radius: 4px; background: #f1f3f4; color: #3c4043; text-align: center; font-weight: 500; padding: 10px 12px; }
    .gi-track-count.is-open { background: #188038; color: #fff; }
    .gi-track-warning { margin: 10px 0 0; color: #8a6116; font-size: 12px; line-height: 1.4; }
    .gi-track-footer { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #e8eaed; }
    .gi-track-notify { color: #3c4043; font-size: 13px; }
    .gi-switch { position: relative; width: 36px; height: 20px; flex: 0 0 auto; border: 0; border-radius: 999px; background: #dadce0; padding: 0; cursor: pointer; }
    .gi-switch[aria-checked="true"] { background: #188038; }
    .gi-switch-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 160ms ease; }
    .gi-switch[aria-checked="true"] .gi-switch-knob { transform: translateX(16px); }
    .gi-track-arrow { position: absolute; width: 12px; height: 12px; background: #fff; transform: translateX(-50%) rotate(45deg); }
    .gi-track-card[data-placement="above"] .gi-track-arrow { bottom: -6px; }
    .gi-track-card[data-placement="below"] .gi-track-arrow { top: -6px; }
  `;
  document.documentElement.append(style);
}

const SINGLE_CHECK = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="M2.5 8.2 6.2 11.8 13.5 4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DOUBLE_CHECK = `<svg viewBox="0 0 20 16" width="18" height="14" fill="none" aria-hidden="true"><path d="M1.2 8.2 4.3 11.3 10.2 4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.2 8.4 10.3 11.5 18.2 3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const EYE_ICON = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="M1.8 10S4.8 4.8 10 4.8 18.2 10 18.2 10 15.2 15.2 10 15.2 1.8 10 1.8 10Z" stroke="#5f6368" stroke-width="1.4"/><circle cx="10" cy="10" r="2.2" stroke="#5f6368" stroke-width="1.4"/></svg>`;
