export type TabRef = {
  id?: number;
  url?: string;
  active?: boolean;
};

/**
 * Foreground actions use the active Gmail tab.
 * Background actions use only the dedicated worker tab.
 * The first Gmail tab in an arbitrary query is never selected.
 */
export function selectGmailTab(input: {
  mode: 'foreground' | 'background';
  activeTab?: TabRef | null;
  workerTabId: number | null;
  gmailTabs?: TabRef[];
}): { tabId: number | null; reason?: string } {
  if (input.mode === 'foreground') {
    const active = input.activeTab;
    if (active?.id != null && active.url?.includes('mail.google.com')) {
      return { tabId: active.id };
    }
    return { tabId: null, reason: 'Active tab is not Gmail' };
  }
  if (input.workerTabId == null) {
    return { tabId: null, reason: 'Worker tab is not ready' };
  }
  return { tabId: input.workerTabId };
}
