/**
 * @vitest-environment jsdom
 */
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@gi/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  attachSdkComposeTracking,
  getComposeSession,
  installDomComposeTracking,
  listComposeSessions,
  planTrackingInjection,
  prepareDomCompose,
  resetComposeSessionsForTests,
  type SdkComposeView,
} from './compose-tracking';

const settings: ExtensionSettings = {
  ...DEFAULT_SETTINGS,
  trackingEnabled: true,
  trackOpens: true,
  trackLinks: true,
  trackerBaseUrl: 'https://track.example',
  personalApiToken: 'token',
};

function deps(create?: (input: { links?: Array<{ url: string }> }) => { tracking_id: string }) {
  let n = 0;
  return {
    getSettings: () => settings,
    refreshSettings: async () => undefined,
    createTracked: async (input: { links?: Array<{ url: string }> }) => {
      n += 1;
      return create?.(input) || {
        tracking_id: `trk_${n}`,
        pixel_url: `https://track.example/open/trk_${n}`,
        rewritten_links: [{ click_id: 'clk_1', original: 'https://example.com/docs', tracked_url: 'https://track.example/c/clk_1' }],
      };
    },
    linkTracked: () => undefined,
  };
}

describe('compose tracking does not block send', () => {
  it('sends the original body when tracking is not ready', async () => {
    resetComposeSessionsForTests();
    let modifier: ((params: { body: string }) => Promise<{ body: string }>) | null = null;
    const view: SdkComposeView = {
      registerRequestModifier(fn) {
        modifier = fn;
      },
      on() {},
      getSubject: () => 'Hello',
      getToRecipients: () => [{ emailAddress: 'a@b.com' }],
      getElement: () => document.createElement('div'),
    };
    attachSdkComposeTracking(view, {
      ...deps(),
      createTracked: () => new Promise(() => undefined),
    });
    const result = await modifier?.({ body: '<p>Hi</p>' });
    expect(result?.body).toBe('<p>Hi</p>');
    expect(planTrackingInjection(undefined)).toBe('send-untracked');
  });

  it('injects a preallocated pixel without cancelling send', async () => {
    resetComposeSessionsForTests();
    let modifier: ((params: { body: string; isPlainText?: boolean }) => Promise<{ body: string }>) | null = null;
    const cancelled = false;
    const element = document.createElement('div');
    element.id = 'compose-a';
    element.innerHTML = '<div aria-label="Message Body"><p>Hi <a href="https://example.com/docs">docs</a></p></div>';
    const body = element.querySelector<HTMLElement>('[aria-label="Message Body"]')!;
    const view: SdkComposeView = {
      registerRequestModifier(fn) {
        modifier = fn;
      },
      on() {},
      getSubject: () => 'Hello',
      getToRecipients: () => [{ emailAddress: 'a@b.com' }],
      getBodyElement: () => body,
      getElement: () => element,
    };
    const id = attachSdkComposeTracking(view, deps());
    await vi.waitFor(() => expect(getComposeSession(id)?.ready).toBe(true));
    const result = await modifier?.({
      body: '<p>Hi <a href="https://example.com/docs">docs</a></p>',
    });
    expect(cancelled).toBe(false);
    expect(result?.body).toContain('https://track.example/open/trk_1');
    expect(result?.body).toContain('https://track.example/c/clk_1');
    expect(result?.body).not.toContain('https://example.com/docs');
  });

  it('keeps separate state for reply and forward windows', async () => {
    resetComposeSessionsForTests();
    document.body.innerHTML = `
      <div role="dialog" aria-label="Reply">
        <span email="a@b.com"></span>
        <div aria-label="Message Body"><p>Hi</p></div>
        <div data-tooltip="Send"></div>
      </div>
      <div role="dialog" aria-label="Forward">
        <span email="c@d.com"></span>
        <div aria-label="Message Body"><p>FYI <a href="https://example.com/docs">docs</a></p></div>
        <div data-tooltip="Send"></div>
      </div>`;
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
    const tracking = deps();
    const ids = dialogs.map((dialog) => prepareDomCompose(dialog, tracking));
    expect(new Set(ids).size).toBe(2);
    await vi.waitFor(() => expect(listComposeSessions().filter((session) => session.ready)).toHaveLength(2));
    expect(listComposeSessions().map((session) => session.kind).sort()).toEqual(['forward', 'reply']);
    expect(listComposeSessions().map((session) => session.trackingId)).toEqual(['trk_1', 'trk_2']);
    installDomComposeTracking({ ...deps(), sdkOwnsCompose: () => false });
    const send = dialogs[0]!.querySelector('[data-tooltip="Send"]')!;
    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    send.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(dialogs[0]!.querySelector('[aria-label="Message Body"]')?.innerHTML).toContain('/open/trk_1');
    expect(dialogs[1]!.querySelector('[aria-label="Message Body"]')?.innerHTML || '').not.toContain('/open/trk_1');
  });
});
