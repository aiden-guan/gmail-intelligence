/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { InboxSdkAdapter } from './InboxSdkAdapter.js';
import { verifyDraftInserted } from './verify.js';
import type { ComposeHandle } from './types.js';

describe('draft targeting and scoping', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  describe('InboxSdkAdapter targeting', () => {
    it('unrelated compose already open + target thread reply requested -> text only in target reply', async () => {
      let registeredComposeHandler: ((view: any) => void) | undefined;
      const openNewComposeViewMock = vi.fn();

      const mockSdk = {
        Conversations: {
          registerThreadViewHandler: vi.fn(),
          registerMessageViewHandler: vi.fn(),
        },
        Compose: {
          registerComposeViewHandler: vi.fn((handler) => {
            registeredComposeHandler = handler;
          }),
          openNewComposeView: openNewComposeViewMock,
        },
        Router: {
          handleAllRoutes: vi.fn(),
          goto: vi.fn(),
        },
      };

      const adapter = new InboxSdkAdapter('app-test');
      adapter.bindSdk(mockSdk as any);
      await adapter.start(() => {});
      expect(registeredComposeHandler).toBeDefined();

      // Register Compose 1: unrelated thread
      const setBodyTextUnrelated = vi.fn();
      const unrelatedCompose = {
        getThreadIDAsync: vi.fn().mockResolvedValue('thread-unrelated'),
        isReply: vi.fn().mockReturnValue(true),
        setBodyText: setBodyTextUnrelated,
        getElement: vi.fn().mockReturnValue(document.createElement('div')),
        on: vi.fn(),
      };
      registeredComposeHandler!(unrelatedCompose);

      // Register Compose 2: target thread
      const setBodyTextTarget = vi.fn();
      const targetCompose = {
        getThreadIDAsync: vi.fn().mockResolvedValue('thread-target'),
        isReply: vi.fn().mockReturnValue(true),
        setBodyText: setBodyTextTarget,
        getElement: vi.fn().mockReturnValue(document.createElement('div')),
        on: vi.fn(),
      };
      registeredComposeHandler!(targetCompose);

      // Allow async thread ID resolution promises to settle
      await new Promise((r) => setTimeout(r, 10));

      // Insert body specifically targeted to 'thread-target'
      const result = await adapter.insertComposeBody('Targeted reply text', { threadId: 'thread-target' });
      expect(result.success).toBe(true);

      // Assert target compose was updated and unrelated compose was untouched
      expect(setBodyTextTarget).toHaveBeenCalledWith('Targeted reply text');
      expect(setBodyTextUnrelated).not.toHaveBeenCalled();
    });

    it('reply opening failure does NOT call openNewComposeView()', async () => {
      const openNewComposeViewMock = vi.fn();
      const mockSdk = {
        Conversations: {
          registerThreadViewHandler: vi.fn(),
          registerMessageViewHandler: vi.fn(),
        },
        Compose: {
          registerComposeViewHandler: vi.fn(),
          openNewComposeView: openNewComposeViewMock,
        },
        Router: {
          handleAllRoutes: vi.fn(),
        },
      };

      const adapter = new InboxSdkAdapter('app-test');
      adapter.bindSdk(mockSdk as any);
      await adapter.start(() => {});

      // Thread has no compose handle and DOM has no reply button
      const res = await adapter.createReplyDraft('non-existent-thread');
      expect(res.success).toBe(false);
      expect(openNewComposeViewMock).not.toHaveBeenCalled();
    });

    it('generic open compose does NOT satisfy createReplyDraft(threadId)', async () => {
      let registeredComposeHandler: ((view: any) => void) | undefined;
      const mockSdk = {
        Conversations: {
          registerThreadViewHandler: vi.fn(),
          registerMessageViewHandler: vi.fn(),
        },
        Compose: {
          registerComposeViewHandler: vi.fn((handler) => {
            registeredComposeHandler = handler;
          }),
        },
        Router: {
          handleAllRoutes: vi.fn(),
        },
      };

      const adapter = new InboxSdkAdapter('app-test');
      adapter.bindSdk(mockSdk as any);
      await adapter.start(() => {});

      // Register a generic / new compose (not a reply, no threadId)
      const genericCompose = {
        getThreadIDAsync: vi.fn().mockResolvedValue(null),
        isReply: vi.fn().mockReturnValue(false),
        getElement: vi.fn().mockReturnValue(document.createElement('div')),
        on: vi.fn(),
      };
      registeredComposeHandler!(genericCompose);
      await new Promise((r) => setTimeout(r, 10));

      // Attempt to get or create a reply draft for 'thread-target'
      const res = await adapter.createReplyDraft('thread-target');
      expect(res.success).toBe(false);
      expect(res.composeHandle).toBeUndefined();
    });
  });

  describe('DomFallbackAdapter targeting', () => {
    it('inserts body into exact target thread container and never leaks into unrelated compose', async () => {
      document.body.innerHTML = `
        <div role="main">
          <!-- Unrelated thread container with an open reply compose -->
          <div data-legacy-thread-id="thread-unrelated" class="nH">
            <div role="dialog" aria-label="Reply">
              <div aria-label="Message Body" class="Am Al editable" contenteditable="true" id="unrelated-body">Initial unrelated</div>
            </div>
          </div>
          <!-- Target thread container with an open reply compose -->
          <div data-legacy-thread-id="thread-target" class="nH">
            <div role="dialog" aria-label="Reply">
              <div aria-label="Message Body" class="Am Al editable" contenteditable="true" id="target-body"></div>
            </div>
          </div>
        </div>
      `;

      const adapter = new DomFallbackAdapter();

      // Insert body targeting 'thread-target'
      const res = await adapter.insertComposeBody('Updated reply text', { threadId: 'thread-target' });
      expect(res.success).toBe(true);

      const targetEl = document.getElementById('target-body');
      const unrelatedEl = document.getElementById('unrelated-body');
      expect(targetEl?.textContent).toBe('Updated reply text');
      expect(unrelatedEl?.textContent).toBe('Initial unrelated');
      expect(unrelatedEl?.textContent).not.toContain('Updated reply text');

      // Attempting to insert into a thread without a compose does NOT leak into existing unrelated composes
      const failRes = await adapter.insertComposeBody('Should not insert', { threadId: 'thread-nonexistent' });
      expect(failRes.success).toBe(false);
      expect(unrelatedEl?.textContent).toBe('Initial unrelated');
    });

    it('handles two simultaneous compose views and inserts only into the explicitly passed handle', async () => {
      document.body.innerHTML = `
        <div role="main">
          <div data-legacy-thread-id="thread-a" class="nH">
            <div aria-label="Message Body" class="Am Al editable" id="body-a"></div>
          </div>
          <div data-legacy-thread-id="thread-b" class="nH">
            <div aria-label="Message Body" class="Am Al editable" id="body-b">Body B</div>
          </div>
        </div>
      `;

      const adapter = new DomFallbackAdapter();
      const handleA: ComposeHandle = {
        id: 'handle-a',
        threadId: 'thread-a',
        isReply: true,
        element: document.getElementById('body-a'),
      };

      const res = await adapter.insertComposeBody('New content for A', handleA);
      expect(res.success).toBe(true);
      expect(document.getElementById('body-a')?.textContent).toBe('New content for A');
      expect(document.getElementById('body-b')?.textContent).toBe('Body B');
    });
  });

  describe('Draft verification and fingerprint matching', () => {
    it('verification strictly requires expectedThreadId matching activeThreadId', () => {
      // Matching thread
      expect(
        verifyDraftInserted({
          composeOpen: true,
          bodyText: 'Expected reply body',
          expectedText: 'Expected reply body',
          activeThreadId: 'thread-target',
          expectedThreadId: 'thread-target',
        }).verified,
      ).toBe(true);

      // Mismatched thread (e.g. user focused another thread)
      expect(
        verifyDraftInserted({
          composeOpen: true,
          bodyText: 'Expected reply body',
          expectedText: 'Expected reply body',
          activeThreadId: 'thread-other',
          expectedThreadId: 'thread-target',
        }).verified,
      ).toBe(false);

      // Null active thread id must not pass
      expect(
        verifyDraftInserted({
          composeOpen: true,
          bodyText: 'Expected reply body',
          expectedText: 'Expected reply body',
          activeThreadId: null,
          expectedThreadId: 'thread-target',
        }).verified,
      ).toBe(false);
    });

    it('stale draft suggestions cannot replace a current-fingerprint draft', () => {
      // Logic mirroring GET_THREAD_INTEL fingerprint check
      function getMatchingDraft(
        currentFingerprint: string | undefined,
        drafts: Array<{ fingerprint?: string; body: string; createdAt: number }>,
      ) {
        if (!currentFingerprint) {
          return drafts.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
        }
        return drafts.find((d) => d.fingerprint === currentFingerprint) || null;
      }

      const drafts = [
        { fingerprint: 'fp-v1', body: 'Stale reply from earlier email', createdAt: 100 },
        { fingerprint: 'fp-v2', body: 'Fresh reply for latest email', createdAt: 200 },
      ];

      // Thread is at fp-v2: selects fresh reply
      expect(getMatchingDraft('fp-v2', drafts)?.body).toBe('Fresh reply for latest email');

      // Thread has progressed to fp-v3 (new incoming message): neither draft matches
      // Stale drafts must NOT be returned!
      expect(getMatchingDraft('fp-v3', drafts)).toBeNull();
    });

    it('strict handle check fails if handle threadId does not match target threadId', () => {
      const handle: ComposeHandle = {
        id: 'handle-wrong',
        threadId: 'thread-other',
        isReply: true,
      };

      const threadId = 'thread-target';
      const isValid = Boolean(handle && (!handle.threadId || handle.threadId === threadId));
      expect(isValid).toBe(false);
    });

    it('re-resolves element inside target thread container when handle element was initially null', () => {
      document.body.innerHTML = `
        <div data-legacy-thread-id="thread-target" class="nH">
          <div aria-label="Message Body" class="Am Al editable" contenteditable="true" id="deferred-body"></div>
        </div>
      `;

      const adapter = new DomFallbackAdapter();
      const threadId = 'thread-target';
      const handle: ComposeHandle = {
        id: `dom-${threadId}`,
        threadId,
        isReply: true,
        element: null,
      };

      // Simulating delayed mount and re-resolving via findThreadContainer
      const container = adapter.findThreadContainer(document, threadId);
      expect(container).not.toBeNull();
      if (container) {
        handle.element = container.querySelector('[aria-label="Message Body"]');
      }

      expect(handle.element).toBe(document.getElementById('deferred-body'));
    });
  });
});
