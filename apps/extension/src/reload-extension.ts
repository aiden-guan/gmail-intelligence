/** Set before chrome.runtime.reload() so the restarted worker can refresh Gmail. */
export const GMAIL_RELOAD_AFTER_RESTART_KEY = 'giReloadGmailAfterRestart';

type StorageArea = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

type ReloadChrome = {
  storage: { local: Pick<StorageArea, 'set'> };
  runtime: { reload: () => void };
};

type RefreshChrome = {
  storage: { local: Pick<StorageArea, 'get' | 'remove'> };
  tabs: {
    query: (query: { url: string }) => Promise<Array<{ id?: number }>>;
    reload: (tabId: number) => Promise<void> | void;
  };
};

/**
 * Persist a one-shot flag, then restart the extension.
 * chrome://extensions reload leaves the open Gmail page on a dead content script.
 * The flag tells the new worker to refresh those tabs after it starts.
 */
export async function requestExtensionReload(api: ReloadChrome): Promise<void> {
  await api.storage.local.set({ [GMAIL_RELOAD_AFTER_RESTART_KEY]: true });
  api.runtime.reload();
}

export async function refreshGmailTabsAfterRestart(api: RefreshChrome): Promise<number> {
  const stored = await api.storage.local.get(GMAIL_RELOAD_AFTER_RESTART_KEY);
  if (stored[GMAIL_RELOAD_AFTER_RESTART_KEY] !== true) return 0;
  await api.storage.local.remove(GMAIL_RELOAD_AFTER_RESTART_KEY);
  const tabs = await api.tabs.query({ url: 'https://mail.google.com/*' });
  const ids = tabs.map((tab) => tab.id).filter((id): id is number => id != null);
  await Promise.all(ids.map((id) => api.tabs.reload(id)));
  return ids.length;
}
