import { useEffect, useState } from 'react';

type Diagnostics = {
  gmailTab?: string;
  ai?: { status?: string; provider?: string };
  tracking?: string;
};

export function PopupApp() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (response?: Diagnostics) => {
      if (response) setDiag(response);
    });
  }, []);

  const ai = diag?.ai?.status === 'ready' ? 'AI ready' : diag?.ai?.status === 'disabled' ? 'AI off' : 'AI needs setup';
  const tracking = diag?.tracking === 'healthy' ? 'Tracker connected' : diag?.tracking === 'not_configured' ? 'Tracking not set up' : 'Tracker unavailable';

  return (
    <div className="w-[280px] bg-white p-4 text-[#202124]">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#5f6368]">Gmail Intelligence</div>
      <ul className="mt-3 space-y-1 text-[13px]">
        <li>{diag?.gmailTab === 'connected' ? '✓ Gmail connected' : 'Gmail not connected'}</li>
        <li>{diag?.ai?.status === 'ready' || diag?.ai?.status === 'disabled' ? `✓ ${ai}` : ai}</li>
        <li>{diag?.tracking === 'healthy' ? `✓ ${tracking}` : tracking}</li>
      </ul>
      <div className="mt-4 flex flex-col gap-2">
        <button className="rounded border border-[#dadce0] px-3 py-2 text-left text-[13px]" onClick={() => chrome.tabs.create({ url: 'https://mail.google.com/' })}>
          Open Gmail
        </button>
        <button className="rounded border border-[#dadce0] px-3 py-2 text-left text-[13px]" onClick={() => void openInbox()}>
          Open Inbox Intelligence
        </button>
        <button className="rounded border border-[#dadce0] px-3 py-2 text-left text-[13px]" onClick={() => chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </div>
    </div>
  );
}

async function openInbox(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId != null) {
    await chrome.runtime.sendMessage({ type: 'FOCUS_SIDEPANEL', mode: 'inbox' });
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}
