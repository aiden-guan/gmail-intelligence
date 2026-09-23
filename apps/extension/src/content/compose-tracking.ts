import type { ExtensionSettings } from '@gi/shared';
import {
  applyTrackingToOutgoingHtml,
  extractHttpLinks,
  pairRewrittenLinks,
  type CreateTrackedEmailInput,
  type CreateTrackedEmailResult,
} from '@gi/tracking';
import { findComposeBody, findSendButton, threadIdFromLocation } from '@gi/gmail';
import { ensureSurface } from './surface';

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
    modifier: (params: { body: string; isPlainText?: boolean }) => Promise<{ body: string; ishtml?: '1' }>,
  ) => void;
  getSubject?: () => string;
  getToRecipients?: () => ComposeRecipient[];
  getCcRecipients?: () => ComposeRecipient[];
  getBccRecipients?: () => ComposeRecipient[];
  getFromContact?: () => { emailAddress?: string } | null;
  getBodyElement?: () => HTMLElement | null;
  getTextContent?: () => string;
  getHTMLContent?: () => string;
  setBodyHTML?: (html: string) => void;
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
  inflight: Promise<ComposeTrackState | null> | null;
  releasing: boolean;
  passthrough: boolean;
};

const sessions = new Map<string, ComposeTrackState>();
const composeTimers = new Set<number>();

export function getComposeSession(composeId: string): ComposeTrackState | undefined {
  return sessions.get(composeId);
}

export function listComposeSessions(): ComposeTrackState[] {
  return [...sessions.values()];
}

export function resetComposeSessionsForTests(): void {
  for (const timer of composeTimers) window.clearInterval(timer);
  composeTimers.clear();
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
    inflight: null,
    releasing: false,
    passthrough: false,
  };
  sessions.set(composeId, session);
  return session;
}

/** How long send may wait for the tracker before the message goes out without a pixel. */
export const TRACKING_READY_WAIT_MS = 3000;

/**
 * InboxSDK send path.
 * The request modifier is what actually lands in the message Gmail delivers.
 * It is registered again until a draft id exists, and it waits for the pixel on send.
 */
export function attachSdkComposeTracking(view: SdkComposeView, deps: ComposeTrackingDeps): string {
  const element = view.getElement?.() || null;
  const composeId = element ? composeElementId(element) : `compose-${Math.random().toString(36).slice(2, 10)}`;
  ensureSession(composeId, deps.getSettings(), composeKind(element));
  if (element) mountTrackingControl(element, composeId, deps);

  let modifierInstalled = false;
  const installModifier = () => {
    if (modifierInstalled || !view.registerRequestModifier) return modifierInstalled;
    try {
      view.registerRequestModifier(async (params) => {
        const session = sessions.get(composeId);
        const ready = await ensureReady(composeId, view, deps);
        const next = trackedOutgoingBody(params.body || '', Boolean(params.isPlainText), ready);
        const wanted = Boolean(session && (session.trackOpens || session.trackLinks));
        if (wanted && (!ready?.pixelUrl || !next.body.includes(ready.pixelUrl))) {
          console.info('[gi] sending without an open pixel');
        }
        return next;
      });
      modifierInstalled = true;
    } catch (error) {
      console.info('[gi] tracking modifier waiting for a draft id', error);
    }
    return modifierInstalled;
  };

  const preallocate = () => {
    installModifier();
    const current = sessions.get(composeId);
    if (current && !current.ready) void prepareSession(composeId, view, deps);
  };
  preallocate();

  const timer = window.setInterval(() => {
    if (!sessions.has(composeId)) {
      window.clearInterval(timer);
      composeTimers.delete(timer);
      return;
    }
    preallocate();
  }, 1000);
  composeTimers.add(timer);
  const stop = () => {
    window.clearInterval(timer);
    composeTimers.delete(timer);
  };
  view.on?.('destroy', stop);
  view.on?.('draftSaved', preallocate);
  view.on?.('recipientsChanged', preallocate);

  view.on?.('presending', (event) => {
    const current = sessions.get(composeId);
    if (current?.releasing) {
      current.releasing = false;
      installModifier();
      if (planTrackingInjection(current) === 'inject') stampBody(view, current);
      return;
    }
    if (!wantsTracking(current, deps)) return;
    if (installModifier()) return;
    if (!event?.cancel || !view.send) return;
    event.cancel();
    void (async () => {
      const ready = await ensureReady(composeId, view, deps);
      installModifier();
      const session = sessions.get(composeId);
      if (session) session.releasing = true;
      if (ready && planTrackingInjection(ready) === 'inject') stampBody(view, ready);
      view.send?.();
    })();
  });

  view.on?.('sent', (event) => {
    stop();
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

export function trackedOutgoingBody(
  body: string,
  isPlainText: boolean,
  session: ComposeTrackState | null | undefined,
): { body: string; ishtml?: '1' } {
  if (!session || planTrackingInjection(session) !== 'inject') return { body };
  if (isPlainText) {
    return { body: injectReady(plainTextToHtml(body), session), ishtml: '1' };
  }
  return { body: injectReady(body, session) };
}

export function installDomComposeTracking(
  deps: ComposeTrackingDeps & { sdkOwnsCompose: () => boolean },
): () => void {
  const composeFrom = (event: Event): { compose: HTMLElement; sendButton: HTMLElement } | null => {
    if (deps.sdkOwnsCompose()) return null;
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const sendButton = target.closest(SEND_BUTTON);
    if (!(sendButton instanceof HTMLElement)) return null;
    const compose = sendButton.closest(COMPOSE_ROOT);
    if (!(compose instanceof HTMLElement)) return null;
    return { compose, sendButton };
  };

  const onPointerDown = (event: Event) => {
    const hit = composeFrom(event);
    if (!hit) return;
    const composeId = composeElementId(hit.compose);
    const session = sessions.get(composeId);
    if (planTrackingInjection(session) !== 'inject' || !session) return;
    const body = findComposeBody(hit.compose);
    if (body) applyToElement(body, session);
  };

  const onClick = (event: Event) => {
    const hit = composeFrom(event);
    if (!hit) return;
    const composeId = composeElementId(hit.compose);
    ensureSession(composeId, deps.getSettings(), composeKind(hit.compose));
    const session = sessions.get(composeId);
    if (session?.passthrough) {
      session.passthrough = false;
      if (planTrackingInjection(session) === 'inject') {
        const body = findComposeBody(hit.compose);
        if (body) applyToElement(body, session);
      }
      return;
    }
    if (!wantsTracking(session, deps)) return;
    if (planTrackingInjection(session) === 'inject' && session) {
      const body = findComposeBody(hit.compose);
      if (body) applyToElement(body, session);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      const ready = await ensureReady(composeId, domComposeView(hit.compose, findComposeBody(hit.compose)), deps);
      const current = sessions.get(composeId);
      if (current) current.passthrough = true;
      if (ready && planTrackingInjection(ready) === 'inject') {
        const body = findComposeBody(hit.compose);
        if (body) applyToElement(body, ready);
      }
      hit.sendButton.click();
    })();
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('click', onClick, true);
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('click', onClick, true);
  };
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
  if (!session) return null;
  if (session.ready) return session;
  if (session.inflight) return session.inflight;
  let resolveReady: (value: ComposeTrackState | null) => void = () => undefined;
  const work = new Promise<ComposeTrackState | null>((resolve) => {
    resolveReady = resolve;
  });
  session.inflight = work;
  void prepareSessionNow(composeId, view, deps)
    .then((value) => resolveReady(value))
    .catch(() => resolveReady(sessions.get(composeId) || null))
    .finally(() => {
      const current = sessions.get(composeId);
      if (current?.inflight === work) current.inflight = null;
    });
  return work;
}

async function prepareSessionNow(
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
  if (!session.trackOpens && !session.trackLinks) return session;
  const recipients = collectRecipients(view);
  if (recipients.length === 0) return session;
  const html = view.getHTMLContent?.() || view.getBodyElement?.()?.innerHTML || '';
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
  // Put the tracking markup into the live compose immediately. Gmail can skip
  // request modifiers for some compose/send paths, so the outgoing request
  // modifier remains a fallback rather than the only injection point.
  stampBody(view, current);
  return current;
}

async function ensureReady(
  composeId: string,
  view: SdkComposeView,
  deps: ComposeTrackingDeps,
): Promise<ComposeTrackState | null> {
  const existing = sessions.get(composeId);
  if (!existing) return null;
  if (existing.ready && planTrackingInjection(existing) === 'inject') return existing;
  const pending = prepareSession(composeId, view, deps);
  const ready = await Promise.race([
    pending,
    new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), TRACKING_READY_WAIT_MS);
    }),
  ]);
  if (ready?.ready && planTrackingInjection(ready) === 'inject') return ready;
  const current = sessions.get(composeId);
  return current?.ready && planTrackingInjection(current) === 'inject' ? current : null;
}

function injectReady(html: string, session: ComposeTrackState): string {
  return applyTrackingToOutgoingHtml(html, {
    pixelUrl: session.pixelUrl,
    linkMap: session.linkMap,
    trackOpens: session.trackOpens,
    trackLinks: session.trackLinks,
  });
}

function plainTextToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div>${escaped.replace(/\r\n|\r|\n/g, '<br>')}</div>`;
}

function stampBody(view: SdkComposeView, session: ComposeTrackState): void {
  const currentHtml = view.getHTMLContent?.() || view.getBodyElement?.()?.innerHTML || '';
  const next = injectReady(currentHtml, session);
  if (next === currentHtml) return;
  if (view.setBodyHTML) view.setBodyHTML(next);
  else applyToElementIfPresent(view, next);
}

function applyToElementIfPresent(view: SdkComposeView, html: string): void {
  const body = view.getBodyElement?.();
  if (body) body.innerHTML = html;
}

function wantsTracking(session: ComposeTrackState | undefined, deps: ComposeTrackingDeps): boolean {
  if (!canTrack(deps.getSettings())) return false;
  if (!session) return true;
  return session.trackOpens || session.trackLinks;
}

function applyToElement(body: HTMLElement, session: ComposeTrackState): void {
  body.innerHTML = injectReady(body.innerHTML, session);
}

function mountTrackingControl(compose: HTMLElement, composeId: string, deps: ComposeTrackingDeps): void {
  if (compose.querySelector('[data-gi-ui="track-toggle"]')) return;
  ensureSurface();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'gi-compose-track';
  button.setAttribute('data-gi-ui', 'track-toggle');
  const paint = () => {
    const session = sessions.get(composeId);
    const on = Boolean(session && (session.trackOpens || session.trackLinks) && canTrack(deps.getSettings()));
    button.dataset.on = on ? '1' : '0';
    button.textContent = on ? 'Tracking' : 'Tracking off';
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
  ensureSurface();
  const menu = document.createElement('div');
  menu.className = 'gi-menu';
  menu.setAttribute('data-gi-ui', 'track-menu');
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
  row.className = 'gi-menu-row';
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
  root?.querySelectorAll('[email], [data-hovercard-id], [data-email]').forEach((node) => {
    const email = node.getAttribute('email') || node.getAttribute('data-hovercard-id') || node.getAttribute('data-email') || '';
    if (email.includes('@')) fromDom.push(email);
  });
  root
    ?.querySelectorAll('input[name="to"], input[name="cc"], input[name="bcc"], textarea[name="to"], textarea[name="cc"], textarea[name="bcc"]')
    .forEach((node) => {
      const value = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : '';
      for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) fromDom.push(match[0]);
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
  if (!gmailThreadId) gmailThreadId = threadIdFromLocation() || null;
  deps.linkTracked({ trackingId, gmailThreadId, gmailMessageId });
  if (!gmailThreadId) {
    window.setTimeout(() => {
      const fromHash = threadIdFromLocation();
      if (fromHash) deps.linkTracked({ trackingId, gmailThreadId: fromHash, gmailMessageId });
    }, 1200);
  }
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
