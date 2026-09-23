/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { GmailActionAdapter } from './GmailActionAdapter.js';
import { validateGmailJsBridgePayload } from './GmailJsCaptureAdapter.js';
import { CompositeGmailAdapter } from './index.js';
import { findThreadRows, getThreadIdFromRow, isOpenThreadRoute, messageText, SELECTORS, threadIdFromLocation } from './selectors.js';

function fixtureInbox(): void {
  document.body.innerHTML = `
    <div role="main">
      <table>
        <tr class="zA zE" data-legacy-thread-id="thread-1">
          <td class="yW"><span email="alice@example.com">Alice</span></td>
          <td class="y6"><span class="bog">Hello from Alice</span></td>
          <td class="y2">Short snippet</td>
        </tr>
        <tr class="zA" data-legacy-thread-id="thread-2">
          <td class="yW"><span email="bob@example.com">Bob</span></td>
          <td class="y6"><span class="bog">Project update</span></td>
          <td class="y2">FYI status</td>
        </tr>
      </table>
      <div role="dialog" aria-label="Compose">
        <input name="subjectbox" value="Re: Hello" />
        <textarea name="to">alice@example.com</textarea>
        <div aria-label="Message Body" g_editable="true" contenteditable="true">Draft text</div>
      </div>
      <div aria-label="Archive"></div>
      <div data-gi-ui="1"><tr class="zA" data-legacy-thread-id="injected-should-skip"></tr></div>
    </div>
  `;
}

describe('DomFallbackAdapter fixtures', () => {
  beforeEach(() => {
    fixtureInbox();
  });

  it('extracts thread rows and skips injected UI', async () => {
    const adapter = new DomFallbackAdapter();
    const res = await adapter.observeInbox();
    expect(res.success).toBe(true);
    expect(res.rows?.map((r) => r.threadId)).toEqual(['thread-1', 'thread-2']);
    expect(res.rows?.[0]?.subject).toMatch(/Hello from Alice/);
  });

  it('reads a thread id that lives on the subject span', async () => {
    document.body.innerHTML = `
      <div role="main">
        <table>
          <tr>
            <td><span email="alice@example.com">Alice</span></td>
            <td><span data-thread-id="msg-f:1" data-legacy-thread-id="thread-9">Hello from Alice</span></td>
          </tr>
        </table>
      </div>
    `;
    const adapter = new DomFallbackAdapter();
    const res = await adapter.observeInbox();
    expect(res.rows?.map((row) => row.threadId)).toEqual(['thread-9']);
    expect(res.rows?.[0]?.subject).toBe('Hello from Alice');
  });

  it('reads an open message from the page address and the visible text', async () => {
    location.hash = '#sent/KtbxAbc';
    document.body.innerHTML = `
      <div role="main">
        <h2 class="hP">sfefef</h2>
        <div data-message-id="msg-1">
          <span email="me@berkeley.edu">Me</span>
          <div dir="ltr">sfeefse <span class="gi-track-slot">Opened</span></div>
        </div>
      </div>
    `;
    const adapter = new DomFallbackAdapter();
    const res = await adapter.getCurrentThread();
    expect(res.thread?.threadId).toBe('KtbxAbc');
    expect(res.thread?.messages[0]?.bodyText).toBe('sfeefse');
    expect(res.thread?.messages[0]?.sender.email).toBe('me@berkeley.edu');
  });

  it('reads a list row and the message text inside a frame', async () => {
    document.body.innerHTML = `
      <div role="main">
        <div role="list">
          <div role="listitem">
            <span email="ada@example.com">Ada</span>
            <span data-thread-id="thread-f:1" data-legacy-thread-id="thread-7">Weekend sale</span>
          </div>
        </div>
      </div>
    `;
    const rows = findThreadRows(document);
    expect(rows).toHaveLength(1);
    expect(getThreadIdFromRow(rows[0]!)).toBe('thread-7');

    location.hash = '#inbox/thread-7';
    document.body.innerHTML = `
      <div role="main">
        <h2 class="hP">Weekend sale</h2>
        <div class="a3s aiL" data-message-id="m1"></div>
      </div>
    `;
    const frame = document.createElement('iframe');
    document.querySelector('.a3s')!.append(frame);
    const frameBody = frame.contentDocument?.body;
    expect(frameBody).toBeTruthy();
    frameBody!.innerHTML = '<div>Our weekend sale starts Friday.</div>';
    expect(messageText(document.querySelector('.a3s')!)).toBe('Our weekend sale starts Friday.');
    const adapter = new DomFallbackAdapter();
    const opened = await adapter.getCurrentThread();
    expect(opened.thread?.threadId).toBe('thread-7');
    expect(opened.thread?.messages[0]?.bodyText).toBe('Our weekend sale starts Friday.');
  });

  it('detects compose', async () => {
    const adapter = new DomFallbackAdapter();
    const res = await adapter.getCurrentCompose();
    expect(res.success).toBe(true);
    if (!('compose' in res) || !res.compose) throw new Error('missing compose');
    expect(res.compose.subject).toBe('Re: Hello');
    expect(res.compose.bodyText).toMatch(/Draft text/);
  });

  it('archives via toolbar control', async () => {
    const adapter = new DomFallbackAdapter();
    let clicked = false;
    document.querySelector('[aria-label="Archive"]')!.addEventListener('click', () => {
      clicked = true;
    });
    const res = await adapter.archiveThread('thread-1');
    expect(res.success).toBe(true);
    expect(clicked).toBe(true);
  });
});

describe('action queue serialization', () => {
  it('runs one action at a time with verification', async () => {
    const adapter = new DomFallbackAdapter();
    const actions = new GmailActionAdapter(adapter, { defaultMaxAttempts: 2 });
    fixtureInbox();
    let verifyCalls = 0;
    const id = actions.enqueue(
      { kind: 'ARCHIVE_THREAD', threadId: 'thread-1' },
      {
        verify: async () => {
          verifyCalls += 1;
          return true;
        },
      },
    );
    expect(id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(verifyCalls).toBeGreaterThan(0);
  });

  it('enqueueAndWait returns real success/failure (never fakes success)', async () => {
    const adapter = new DomFallbackAdapter();
    const actions = new GmailActionAdapter(adapter, {
      defaultMaxAttempts: 1,
      defaultTimeoutMs: 200,
    });
    fixtureInbox();
    document.querySelector('[aria-label="Archive"]')?.remove();
    const result = await actions.enqueueAndWait(
      { kind: 'ARCHIVE_THREAD', threadId: 'thread-1' },
      { maxAttempts: 1, timeoutMs: 200 },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.actionId).toBeTruthy();
  });
});

describe('adapter fallback + bridge validation', () => {
  it('composite starts with DOM fallback when no SDK', async () => {
    const c = new CompositeGmailAdapter();
    const caps = await c.detectCapabilities();
    expect(caps.domFallbackAvailable).toBe(true);
    expect(caps.inboxSdkAvailable).toBe(false);
    expect(caps.persistentNativeLabelMutationAvailable).toBe(false);
  });

  it('rejects untrusted bridge payloads', () => {
    expect(validateGmailJsBridgePayload(null).ok).toBe(false);
    expect(validateGmailJsBridgePayload({ type: 'email_data', threadId: 't' }).ok).toBe(true);
  });

  it('keeps selectors centralized', () => {
    expect(SELECTORS.threadRow.length).toBeGreaterThan(0);
    expect(SELECTORS.archiveButton.some((s) => s.includes('Archive'))).toBe(true);
  });

  it('reads a checkbox row and stays quiet while a thread is open', async () => {
    expect(isOpenThreadRoute('#sent')).toBe(false);
    expect(isOpenThreadRoute('#sent/KtbxAbc')).toBe(true);
    expect(threadIdFromLocation('#sent/KtbxAbc')).toBe('KtbxAbc');
    document.body.innerHTML = `
      <div role="main">
        <div role="row">
          <div role="gridcell"><div role="checkbox"></div></div>
          <div role="gridcell"><span email="alice@example.com">Alice</span></div>
          <div role="gridcell"><span>Hello from Alice</span></div>
        </div>
      </div>
    `;
    expect(findThreadRows(document)).toHaveLength(1);
    document.body.innerHTML = '<div role="main"><table><tr><td>Message layout</td></tr></table></div>';
    location.hash = '#sent/KtbxAbc';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new DomFallbackAdapter();
    await adapter.observeInbox();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('duplicate injection prevention mark', () => {
  it('uses data-gi-ui marker', () => {
    expect(SELECTORS.injectedUiMark).toBe('[data-gi-ui="1"]');
  });
});
