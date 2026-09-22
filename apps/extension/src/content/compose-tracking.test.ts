/**
 * @vitest-environment jsdom
 */
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@gi/shared';
import { describe, expect, it, vi } from 'vitest';
import { attachSdkComposeTracking, installDomComposeTracking, type SdkComposeView } from './compose-tracking';

const settings: ExtensionSettings = {
  ...DEFAULT_SETTINGS,
  trackingEnabled: true,
  trackOpens: true,
  trackLinks: true,
  trackerBaseUrl: 'https://track.example',
  personalApiToken: 'token',
};

function deps(extra?: {
  create?: (input: { links?: Array<{ url: string }> }) => void;
  link?: (link: { trackingId: string; gmailThreadId: string | null; gmailMessageId: string | null }) => void;
  refresh?: () => void;
}) {
  return {
    getSettings: () => settings,
    refreshSettings: async () => {
      extra?.refresh?.();
    },
    createTracked: async (input: { links?: Array<{ url: string }> }) => {
      extra?.create?.(input);
      return {
        tracking_id: 'trk_abc',
        pixel_url: 'https://track.example/open/trk_abc',
        rewritten_links: [{ click_id: 'clk_1', original: 'https://example.com/docs', tracked_url: 'https://track.example/c/clk_1' }],
      };
    },
    linkTracked: (link: { trackingId: string; gmailThreadId: string | null; gmailMessageId: string | null }) => {
      extra?.link?.(link);
    },
  };
}

describe('compose tracking injection', () => {
  it('cancels send before any async work when the request modifier is not ready', async () => {
    const order: string[] = [];
    const body = document.createElement('div');
    body.innerHTML = '<p>Hi</p>';
    const listeners: Record<string, (event?: { cancel?: () => void }) => void> = {};
    const view: SdkComposeView = {
      registerRequestModifier() {
        throw new Error('draft id missing');
      },
      on(event, cb) {
        listeners[event] = cb;
      },
      send() {
        order.push('send');
      },
      getSubject: () => 'Hello',
      getToRecipients: () => [{ emailAddress: 'a@b.com' }],
      getBodyElement: () => body,
    };
    attachSdkComposeTracking(view, deps({ refresh: () => order.push('refresh') }));
    listeners.presending?.({
      cancel() {
        order.push('cancel');
        expect(order).toEqual(['cancel']);
      },
    });
    await vi.waitFor(() => expect(body.innerHTML).toContain('https://track.example/open/trk_abc'));
    expect(order[0]).toBe('cancel');
    expect(order).toContain('send');
    expect(body.innerHTML).not.toContain('display:none');
  });

  it('rewrites the outgoing body without cancelling when the modifier is registered', async () => {
    let modifier: ((params: { body: string; isPlainText?: boolean }) => Promise<{ body: string }>) | null = null;
    const listeners: Record<string, (event?: { cancel?: () => void; getThreadID?: () => Promise<string>; getMessageID?: () => Promise<string> }) => void> = {};
    let cancelled = false;
    const linked: Array<{ gmailThreadId: string | null; gmailMessageId: string | null }> = [];
    const view: SdkComposeView = {
      registerRequestModifier(fn) {
        modifier = fn;
      },
      on(event, cb) {
        listeners[event] = cb;
      },
      send() {
        throw new Error('modifier path should not resend');
      },
      getSubject: () => 'Hello',
      getToRecipients: () => [{ emailAddress: 'a@b.com' }],
      getFromContact: () => ({ emailAddress: 'me@example.com' }),
    };
    attachSdkComposeTracking(
      view,
      deps({
        link: (link) => linked.push(link),
      }),
    );
    listeners.presending?.({
      cancel() {
        cancelled = true;
      },
    });
    expect(cancelled).toBe(false);
    const result = await modifier?.({
      body: '<p>Hi <a href="https://example.com/docs">docs</a></p>',
      isPlainText: false,
    });
    expect(result?.body).toContain('https://track.example/open/trk_abc');
    expect(result?.body).toContain('https://track.example/c/clk_1');
    expect(result?.body).not.toContain('https://example.com/docs');
    listeners.sent?.({
      getThreadID: async () => 'thread-9',
      getMessageID: async () => 'msg-9',
    });
    await vi.waitFor(() =>
      expect(linked).toEqual([
        { trackingId: 'trk_abc', gmailThreadId: 'thread-9', gmailMessageId: 'msg-9' },
      ]),
    );
  });

  it('adds the pixel from the send button when InboxSDK is unavailable', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div name="to"><span email="a@b.com">A</span></div>
        <input name="subjectbox" value="Hello" />
        <div aria-label="Message Body"><p>Hi</p></div>
        <div data-tooltip="Send"></div>
      </div>
    `;
    const send = document.querySelector('[data-tooltip="Send"]') as HTMLElement;
    let clicks = 0;
    send.addEventListener('click', () => {
      clicks += 1;
    });
    installDomComposeTracking({ ...deps(), sdkOwnsCompose: () => false });
    send.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Message Body"]')?.innerHTML).toContain('/open/trk_abc'));
    expect(clicks).toBe(1);
    expect(document.querySelector('[role="dialog"]')?.getAttribute('data-gi-track-ready')).toBe('1');
  });
});
