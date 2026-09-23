import type { ExtensionSettings } from '@gi/shared';
import {
  applyTrackingToOutgoingHtml,
  extractHttpLinks,
  pairRewrittenLinks,
  type CreateTrackedEmailInput,
  type CreateTrackedEmailResult,
} from '@gi/tracking';
import { findComposeBody, findSendButton } from '@gi/gmail';

export type ComposeRecipient = { emailAddress?: string; email?: string };

export type SdkComposeView = {
  on?: (
    event: string,
    cb: (event?: {
      cancel?: () => void;
      getMessageID?: () => Promise<string>;
      getThreadID?: () => Promise<string>;
    }) => void,
  ) => void;
  send?: () => void;
  registerRequestModifier?: (
    modifier: (params: { body: string; isPlainText?: boolean }) => Promise<{ body: string }>,
  ) => void;
  getSubject?: () => string;
  getToRecipients?: () => ComposeRecipient[];
  getCcRecipients?: () => ComposeRecipient[];
  getBccRecipients?: () => ComposeRecipient[];
  getFromContact?: () => { emailAddress?: string } | null;
  getBodyElement?: () => HTMLElement | null;
  getTextContent?: () => string;
  getElement?: () => HTMLElement | null;
  getThreadID?: () => string | null | undefined | Promise<string | null | undefined>;
  addButton?: (desc: unknown) => void;
};

export type ComposeTrackingDeps = {
  getSettings: () => ExtensionSettings;
  refreshSettings: () => Promise<void>;
  createTracked: (input: CreateTrackedEmailInput) => Promise<CreateTrackedEmailResult | null>;
  linkTracked: (link: {
    trackingId: string;
    gmailThreadId: string | null;
    gmailMessageId: string | null;
  }) => void;
  onSent?: (info: { subject: string; recipients: string[]; bodyText: string }) => void;
};

export type ComposeTrackState = {
  composeId: string;
  trackingId: string | null;
  pixelUrl: string | null;
  linkMap: Map<string, string>;
  ready: boolean;
  trackOpens: boolean;
  trackLinks: boolean;
  kind: 'new' | 'reply' | 'forward';
};

const sessions = new Map<string, ComposeTrackState>();

export function getComposeSession(composeId: string): ComposeTrackState | undefined {
  return sessions.get(composeId);
}

export function listComposeSessions(): ComposeTrackState[] {
  return [...sessions.values()];
}

export function resetComposeSessionsForTests(): void {
  sessions.clear();
}

export function planTrackingInjection(state: ComposeTrackState | undefined): 'inject' | 'send-untracked' {
  if (!state?.ready || !state.pixelUrl) return 'send-untracked';
  if (!state.trackOpens && !state.trackLinks) return 'send-untracked';
  return 'inject';
}

export function composeElementId(el: HTMLElement): string {
  const existing = el.getAttribute('data-gi-compose-id');
  if (existing) return existing;
  const id = el.id || `compose-${Math.random().toString(36).slice(2, 10)}`;
  el.setAttribute('data-gi-compose-id', id);
  return id;
}

function composeKind(el: HTMLElement | null | undefined): ComposeTrackState['kind'] {
  const label = (el?.getAttribute('aria-label') || '').toLowerCase();
  if (label.includes('forward')) return 'forward';
  if (label.includes('reply')) return 'reply';
  return 'new';
}

function ensureSession(composeId: string, settings: ExtensionSettings, kind: ComposeTrackState['kind']): ComposeTrackState {
  const existing = sessions.get(composeId);
  if (existing) return existing;
  const session: ComposeTrackState = {
    composeId,
    trackingId: null,
    pixelUrl: null,
    linkMap: new Map(),
    ready: false,
    trackOpens: settings.trackOpens,
    trackLinks: settings.trackLinks,
    kind,
  };
  sessions.set(composeId, session);
  return session;
}

/**
 * InboxSDK send path. Tracking is preallocated. The modifier never waits on the tracker.
 * If the record is not ready, the original body is sent.
 */
export function attachSdkComposeTracking(view: SdkComposeView, deps: ComposeTrackingDeps): string {
  const element = view.getElement?.() || null;
  const composeId = element ? composeElementId(element) : `compose-${Math.random().toString(36).slice(2, 10)}`;
  ensureSession(composeId, deps.getSettings(), composeKind(element));
  if (element) mountTrackingControl(element, composeId, deps);

  const preallocate = () => {
    void prepareSession(composeId, view, deps);
  };
  preallocate();

  if (view.registerRequestModifier) {
    try {
      view.registerRequestModifier(async (params) => {
        const current = sessions.get(composeId);
        if (params.isPlainText || planTrackingInjection(current) === 'send-untracked') {
          if (current && !current.ready) console.info('[gi] tracking not ready, sending without it');
          return { body: params.body || '' };
        }
        return { body: injectReady(params.body || '', current!) };
      });
    } catch (error) {
      console.warn('[gi] tracking modifier unavailable', error);
    }
  }

  view.on?.('presending', () => {
    const current = sessions.get(composeId);
    if (planTrackingInjection(current) !== 'inject') return;
    const body = view.getBodyElement?.();
    if (body) applyToElement(body, current!);
  });

  view.on?.('sent', (event) => {
    const current = sessions.get(composeId);
    const trackingId = current?.trackingId;
    sessions.delete(composeId);
    deps.onSent?.({
      subject: view.getSubject?.() || '',
      recipients: collectRecipients(view),
      bodyText: view.getTextContent?.() || view.getBodyElement?.()?.textContent || '',
    });
    if (trackingId) void linkSentMessage(view, event, trackingId, deps);
  });

  return composeId;
}

export function installDomComposeTracking(
  deps: ComposeTrackingDeps & { sdkOwnsCompose: () => boolean },
): () => void {
  const onPointerDown = (event: Event) => {
    if (deps.sdkOwnsCompose()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const sendButton = target.closest(SEND_BUTTON);
    if (!(sendButton instanceof HTMLElement)) return;
    const compose = sendButton.closest(COMPOSE_ROOT);
    if (!(compose instanceof HTMLElement)) return;
    const composeId = composeElementId(compose);
    const session = sessions.get(composeId);
    if (planTrackingInjection(session) !== 'inject' || !(event.target instanceof Node)) return;
    const body = findComposeBody(compose);
    if (body && session) applyToElement(body, session);
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  return () => document.removeEventListener('pointerdown', onPointerDown, true);
}

export function prepareDomCompose(compose: HTMLElement, deps: ComposeTrackingDeps): string {
  const composeId = composeElementId(compose);
  ensureSession(composeId, deps.getSettings(), composeKind(compose));
  mountTrackingControl(compose, composeId, deps);
  const body = findComposeBody(compose);
  void prepareSession(composeId, domComposeView(compose, body), deps);
  return composeId;
}

export async function prepareSession(
  composeId: string,
  view: SdkComposeView,
  deps: ComposeTrackingDeps,
): Promise<ComposeTrackState | null> {
  const session = sessions.get(composeId);
  if (!session || session.ready) return session || null;
  await deps.refreshSettings();
  const settings = deps.getSettings();
  if (!canTrack(settings)) return session;
  session.trackOpens = session.trackOpens && settings.trackOpens;
  session.trackLinks = session.trackLinks && settings.trackLinks;
  const recipients = collectRecipients(view);
  if (recipients.length === 0) return session;
  const html = view.getBodyElement?.()?.innerHTML || '';
  const hrefs = session.trackLinks ? extractHttpLinks(html).slice(0, 50) : [];
  const created = await deps.createTracked({
    subject: (view.getSubject?.() || '').slice(0, 998),
    sender: view.getFromContact?.()?.emailAddress || 'me',
    recipients,
    gmail_thread_id: (await readThreadId(view)) || undefined,
    links: hrefs.map((href) => ({ url: decodeURIComponentSafe(href) })),
  });
  const current = sessions.get(composeId);
  if (!current || !created?.pixel_url || !created.tracking_id) return current || null;
  current.trackingId = created.tracking_id;
  current.pixelUrl = created.pixel_url;
  current.linkMap = current.trackLinks ? pairRewrittenLinks(hrefs, created.rewritten_links || []) : new Map();
  current.ready = true;
  return current;
}

function injectReady(html: string, session: ComposeTrackState): string {
  return applyTrackingToOutgoingHtml(html, {
    pixelUrl: session.pixelUrl,
    linkMap: session.linkMap,
    trackOpens: session.trackOpens,
    trackLinks: session.trackLinks,
  });
}

function applyToElement(body: HTMLElement, session: ComposeTrackState): void {
  body.innerHTML = injectReady(body.innerHTML, session);
}

function mountTrackingControl(compose: HTMLElement, composeId: string, deps: ComposeTrackingDeps): void {
  if (compose.querySelector('[data-gi-ui="track-toggle"]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('data-gi-ui', 'track-toggle');
  button.style.cssText =
    'margin:0 8px;border:0;background:transparent;color:#5f6368;font:12px "Google Sans",Roboto,Arial,sans-serif;cursor:pointer;padding:4px';
  const paint = () => {
    const session = sessions.get(composeId);
    const on = Boolean(session && (session.trackOpens || session.trackLinks) && canTrack(deps.getSettings()));
    button.textContent = on ? '✓✓' : 'Tracking off';
    button.title = 'Email tracking';
  };
  paint();
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleMenu(button, composeId, deps, paint);
  });
  const send = findSendButton(compose);
  if (send?.parentElement) send.parentElement.insertBefore(button, send);
  else compose.append(button);
}

function toggleMenu(
  anchor: HTMLButtonElement,
  composeId: string,
  deps: ComposeTrackingDeps,
  paint: () => void,
): void {
  const existing = document.querySelector('[data-gi-ui="track-menu"]');
  if (existing) {
    existing.remove();
    return;
  }
  const session = sessions.get(composeId);
  if (!session) return;
  const menu = document.createElement('div');
  menu.setAttribute('data-gi-ui', 'track-menu');
  menu.style.cssText =
    'position:fixed;z-index:2147483646;background:#fff;border:1px solid #dadce0;border-radius:8px;padding:8px 10px;font:13px "Google Sans",Roboto,Arial,sans-serif;color:#202124;box-shadow:0 4px 16px rgba(32,33,36,.18)';
  menu.append(checkRow('Track opens', session.trackOpens, (on) => {
    session.trackOpens = on;
    session.ready = false;
    paint();
    void prepareSession(composeId, domComposeView(anchor.closest(COMPOSE_ROOT) as HTMLElement, findComposeBody(anchor.closest(COMPOSE_ROOT) as HTMLElement)), deps);
  }));
  menu.append(checkRow('Track links', session.trackLinks, (on) => {
    session.trackLinks = on;
    session.ready = false;
    paint();
  }));
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.left - 80)}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  document.body.append(menu);
}

function checkRow(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0;cursor:pointer';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(input, document.createTextNode(label));
  return row;
}

async function readThreadId(view: SdkComposeView): Promise<string | null> {
  try {
    const value = await view.getThreadID?.();
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

function canTrack(settings: ExtensionSettings): boolean {
  return Boolean(
    settings.trackingEnabled &&
      settings.trackerBaseUrl.trim() &&
      settings.personalApiToken.trim() &&
      (settings.trackOpens || settings.trackLinks),
  );
}

function collectRecipients(view: SdkComposeView): string[] {
  const fromApi = [
    ...(view.getToRecipients?.() || []),
    ...(view.getCcRecipients?.() || []),
    ...(view.getBccRecipients?.() || []),
  ]
    .map((recipient) => recipient.emailAddress || recipient.email || '')
    .filter((email) => email.includes('@'));
  const root = view.getElement?.();
  const fromDom: string[] = [];
  root?.querySelectorAll('[email]').forEach((node) => {
    const email = node.getAttribute('email') || '';
    if (email.includes('@')) fromDom.push(email);
  });
  return [...new Set([...fromApi, ...fromDom].map((email) => email.trim().toLowerCase()))];
}

async function linkSentMessage(
  view: SdkComposeView,
  event: { getMessageID?: () => Promise<string>; getThreadID?: () => Promise<string> } | undefined,
  trackingId: string,
  deps: ComposeTrackingDeps,
): Promise<void> {
  let gmailThreadId: string | null = null;
  let gmailMessageId: string | null = null;
  try {
    gmailThreadId = (await event?.getThreadID?.()) || (await readThreadId(view));
  } catch {
    gmailThreadId = await readThreadId(view);
  }
  try {
    gmailMessageId = (await event?.getMessageID?.()) || null;
  } catch {
    gmailMessageId = null;
  }
  deps.linkTracked({ trackingId, gmailThreadId, gmailMessageId });
}

function domComposeView(compose: HTMLElement | null, body: HTMLElement | null): SdkComposeView {
  const subject = compose?.querySelector('input[name="subjectbox"], input[aria-label="Subject"]');
  return {
    getSubject: () => (subject instanceof HTMLInputElement ? subject.value : ''),
    getElement: () => compose,
    getBodyElement: () => body,
    getTextContent: () => body?.textContent || '',
  };
}

function decodeURIComponentSafe(value: string): string {
  const named = value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  try {
    return new URL(named).toString();
  } catch {
    return named;
  }
}

const SEND_BUTTON = '[data-tooltip="Send"], [aria-label="Send"], [aria-label^="Send "]';
const COMPOSE_ROOT = 'div[role="dialog"], form.bAs, div.AD, div.M9';
