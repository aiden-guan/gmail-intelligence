/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@gi/shared';
import { SettingsApp } from './SettingsApp';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsApp email tracking', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    requestMock = vi.fn();
    sendMessageMock = vi.fn((msg, cb) => {
      if (msg.type === 'GET_SETTINGS') {
        if (typeof cb === 'function') {
          cb({ settings: { ...DEFAULT_SETTINGS } });
        }
      } else if (msg.type === 'CHECK_TRACKER') {
        if (typeof cb === 'function') {
          cb({ status: msg.trackerBaseUrl && msg.personalApiToken ? 'healthy' : 'missing' });
        }
      } else if (msg.type === 'SAVE_SETTINGS') {
        if (typeof cb === 'function') {
          cb({ settings: { ...DEFAULT_SETTINGS, ...msg.settings } });
        }
      }
    });

    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: 'test-extension-id',
        sendMessage: sendMessageMock,
        getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
      },
      permissions: {
        request: requestMock,
      },
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders tracker base URL and token fields in the Email tracking section', async () => {
    await act(async () => {
      root.render(<SettingsApp />);
    });

    const urlInput = container.querySelector('input[placeholder="https://your-tracker.example"]') as HTMLInputElement;
    expect(urlInput).toBeTruthy();

    const tokenInput = container.querySelector('input[placeholder="Personal API token"]') as HTMLInputElement;
    expect(tokenInput).toBeTruthy();
  });

  it('auto-loads bundled tracker-config.json when settings are initially empty', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        trackerBaseUrl: 'https://energized-eagle-668.convex.site',
        personalApiToken: 'gi_local_test_token_123',
      }),
    } as Response);

    await act(async () => {
      root.render(<SettingsApp />);
    });

    expect(fetchMock).toHaveBeenCalledWith('chrome-extension://test-id/tracker-config.json');

    const urlInput = container.querySelector('input[placeholder="https://your-tracker.example"]') as HTMLInputElement;
    expect(urlInput.value).toBe('https://energized-eagle-668.convex.site');

    const tokenInput = container.querySelector('input[placeholder="Personal API token"]') as HTMLInputElement;
    expect(tokenInput.value).toBe('gi_local_test_token_123');

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SAVE_SETTINGS',
        settings: {
          trackerBaseUrl: 'https://energized-eagle-668.convex.site',
          personalApiToken: 'gi_local_test_token_123',
        },
      }),
    );
  });
});
