import type { ExtensionSettings } from '@gi/shared';
import {
  applyTrackingToOutgoingHtml,
  buildTrackingPixelHtml,
  extractHttpLinks,
  pairRewrittenLinks,
  trackingStatusLine,
  type CreateTrackedEmailInput,
  type CreateTrackedEmailResult,
} from '@gi/tracking';

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
  getElement?: () => HTMLElement;
  getThreadID?: () => string | null;
  addStatusBar?: (desc: { height?: number }) => { el: HTMLElement };
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

const CREATE_TIMEOUT_MS = 6000;

/**
 * InboxSDK send path.
 * The request modifier runs on the outgoing send body. If that hook is not
 * ready yet, presending cancels synchronously, the pixel is appended, then send runs again.
 */
export function attachSdkComposeTracking(view: SdkComposeView, deps: ComposeTrackingDeps): void {
  let registered = false;
  let injected = false;
  let pendingTrackingId: string | null = null;

  showComposeStatus(view, deps.getSettings());

  const tryRegister = (): boolean => {
    if (registered || !view.registerRequestModifier) return registered;
    try {
      view.registerRequestModifier(async (params) => {
        const original = params.body || '';
        if (params.isPlainText) return { body: original };
        const next = await withTimeout(modifyOutgoingBody(view, original, deps), CREATE_TIMEOUT_MS, null);
        if (!next) return { body: original };
        pendingTrackingId = next.trackingId;
        return { body: next.html };
      });
      registered = true;
    } catch (error) {
      console.warn('[gi] tracking modifier not ready yet', error);
    }
    return registered;
  };

  tryRegister();
  view.on?.('draftSaved', () => {
    tryRegister();
  });

  view.on?.('presending', (event) => {
    if (registered || injected) return;
    if (!canTrack(deps.getSettings())) return;
    // Cancel before any await. Otherwise Gmail sends the message without the pixel.
    event?.cancel?.();
    void (async () => {
      try {
        await deps.refreshSettings();
        if (!canTrack(deps.getSettings())) return;
        if (tryRegister()) return;
        const html = view.getBodyElement?.()?.innerHTML || '';
        const next = await withTimeout(modifyOutgoingBody(view, html, deps), CREATE_TIMEOUT_MS, null);
        if (next) {
          pendingTrackingId = next.trackingId;
          const body = view.getBodyElement?.();
          if (body && deps.getSettings().trackOpens && next.pixelUrl && !body.innerHTML.includes(next.pixelUrl)) {
            body.insertAdjacentHTML('beforeend', buildTrackingPixelHtml(next.pixelUrl));
          }
          if (deps.getSettings().trackLinks && body) applyLinkMap(body, next.linkMap);
        }
      } catch (error) {
        console.warn('[gi] tracking injection failed (send continues)', error);
      } finally {
        injected = true;
        try {
          view.send?.();
        } catch (error) {
          console.warn('[gi] re-send after tracking failed', error);
        }
      }
    })();
  });

  view.on?.('sent', (event) => {
    const trackingId = pendingTrackingId;
    pendingTrackingId = null;
    injected = false;
    const subject = view.getSubject?.() || '';
    const recipients = collectRecipients(view);
    const bodyText = view.getTextContent?.() || view.getBodyElement?.()?.textContent || '';
    deps.onSent?.({ subject, recipients, bodyText });
    if (!trackingId) return;
    void linkSentMessage(view, event, trackingId, deps);
  });
}

export function installDomComposeTracking(
  deps: ComposeTrackingDeps & { sdkOwnsCompose: () => boolean },
): () => void {
  const onPointerDown = (event: Event) => {
    if (deps.sdkOwnsCompose()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const sendButton = target.closest(SEND_BUTTON);
    if (!sendButton || !(sendButton instanceof HTMLElement)) return;
    const compose = sendButton.closest(COMPOSE_ROOT);
    if (!(compose instanceof HTMLElement)) return;
    if (compose.dataset.giTrackReady === '1') return;
    if (!canTrack(deps.getSettings())) return;
    event.preventDefault();
    event.stopPropagation();
    void armComposeAndResend(compose, sendButton, deps);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (deps.sdkOwnsCompose()) return;
    if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
    const active = document.activeElement;
    const compose = active instanceof Element ? active.closest(COMPOSE_ROOT) : null;
    if (!(compose instanceof HTMLElement)) return;
    if (compose.dataset.giTrackReady === '1') return;
    if (!canTrack(deps.getSettings())) return;
    const sendButton = compose.querySelector(SEND_BUTTON);
    if (!(sendButton instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    void armComposeAndResend(compose, sendButton, deps);
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };
}

async function armComposeAndResend(
  compose: HTMLElement,
  sendButton: HTMLElement,
  deps: ComposeTrackingDeps,
): Promise<void> {
  try {
    await deps.refreshSettings();
    if (canTrack(deps.getSettings())) {
      const body = compose.querySelector(COMPOSE_BODY);
      const html = body instanceof HTMLElement ? body.innerHTML : '';
      const next = await withTimeout(
        modifyOutgoingBody(domComposeView(compose, body), html, deps),
        CREATE_TIMEOUT_MS,
        null,
      );
      if (next && body instanceof HTMLElement) {
        if (deps.getSettings().trackOpens && next.pixelUrl && !body.innerHTML.includes(next.pixelUrl)) {
          body.insertAdjacentHTML('beforeend', buildTrackingPixelHtml(next.pixelUrl));
        }
        if (deps.getSettings().trackLinks) applyLinkMap(body, next.linkMap);
        deps.linkTracked({ trackingId: next.trackingId, gmailThreadId: null, gmailMessageId: null });
      }
    }
  } catch (error) {
    console.warn('[gi] tracking injection failed (send continues)', error);
  } finally {
    compose.dataset.giTrackReady = '1';
    sendButton.click();
  }
}

export async function modifyOutgoingBody(
  view: SdkComposeView,
  html: string,
  deps: ComposeTrackingDeps,
): Promise<{ html: string; trackingId: string; pixelUrl: string; linkMap: Map<string, string> } | null> {
  await deps.refreshSettings();
  const settings = deps.getSettings();
  if (!canTrack(settings)) return null;
  const recipients = collectRecipients(view);
  if (recipients.length === 0) return null;
  const hrefs = settings.trackLinks ? extractHttpLinks(html).slice(0, 50) : [];
  const created = await deps.createTracked({
    subject: (view.getSubject?.() || '').slice(0, 998),
    sender: view.getFromContact?.()?.emailAddress || 'me',
    recipients,
    gmail_thread_id: view.getThreadID?.() || undefined,
    links: hrefs.map((href) => ({ url: decodeURIComponentSafe(href) })),
  });
  if (!created?.pixel_url || !created.tracking_id) return null;
  const linkMap = pairRewrittenLinks(hrefs, created.rewritten_links || []);
  return {
    html: applyTrackingToOutgoingHtml(html, {
      pixelUrl: created.pixel_url,
      linkMap,
      trackOpens: settings.trackOpens,
      trackLinks: settings.trackLinks,
    }),
    trackingId: created.tracking_id,
    pixelUrl: created.pixel_url,
    linkMap,
  };
}

function canTrack(settings: ExtensionSettings): boolean {
  return Boolean(
    settings.trackingEnabled &&
      settings.trackerBaseUrl.trim() &&
      settings.personalApiToken.trim() &&
      (settings.trackOpens || settings.trackLinks),
  );
}

function showComposeStatus(view: SdkComposeView, settings: ExtensionSettings): void {
  const line = trackingStatusLine(settings);
  if (!line || !view.addStatusBar) return;
  try {
    const bar = view.addStatusBar({ height: 28 });
    bar.el.textContent = line;
    bar.el.style.cssText =
      'font:12px/28px "Google Sans",Roboto,Arial,sans-serif;color:#5f6368;padding:0 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  } catch {
    /* compose chrome varies */
  }
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
  root?.querySelectorAll('[name="to"] [email], [name="cc"] [email], [name="bcc"] [email]').forEach((node) => {
    const email = node.getAttribute('email') || '';
    if (email.includes('@')) fromDom.push(email);
  });

  return [...new Set([...fromApi, ...fromDom].map((email) => email.trim().toLowerCase()))];
}

function applyLinkMap(body: HTMLElement, linkMap: Map<string, string>): void {
  if (linkMap.size === 0) return;
  body.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    const tracked = linkMap.get(href);
    if (tracked) anchor.setAttribute('href', tracked);
  });
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
    gmailThreadId = (await event?.getThreadID?.()) || view.getThreadID?.() || null;
  } catch {
    gmailThreadId = view.getThreadID?.() || null;
  }
  try {
    gmailMessageId = (await event?.getMessageID?.()) || null;
  } catch {
    gmailMessageId = null;
  }
  deps.linkTracked({ trackingId, gmailThreadId, gmailMessageId });
}

function domComposeView(compose: HTMLElement, body: Element | null): SdkComposeView {
  const subject = compose.querySelector('input[name="subjectbox"], input[aria-label="Subject"]');
  return {
    getSubject: () => (subject instanceof HTMLInputElement ? subject.value : ''),
    getElement: () => compose,
    getBodyElement: () => (body instanceof HTMLElement ? body : null),
    getTextContent: () => body?.textContent || '',
  };
}

function decodeURIComponentSafe(value: string): string {
  const named = value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  try {
    return new URL(named).toString();
  } catch {
    return named;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

const SEND_BUTTON = '[data-tooltip="Send"], [aria-label="Send"], [aria-label^="Send "]';
const COMPOSE_ROOT = 'div[role="dialog"], form.bAs, div.AD, div.M9';
const COMPOSE_BODY = '[aria-label="Message Body"], div[g_editable="true"], div[contenteditable="true"]';
