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

  const aiReady = diag?.ai?.status === 'ready';
  const aiOff = diag?.ai?.status === 'disabled';
  const ai = aiReady ? 'AI ready' : aiOff ? 'AI off' : 'AI needs setup';
  const trackingReady = diag?.tracking === 'healthy';
  const tracking =
    trackingReady ? 'Tracker connected' : diag?.tracking === 'not_configured' ? 'Tracking not set up' : 'Tracker unavailable';

  return (
    <div className="gi-app w-[320px] p-3">
      <div className="gi-shell">
        <div className="gi-core">
          <div className="flex items-center gap-2.5">
            <span className="gi-mark" aria-hidden="true" />
            <div>
              <div className="gi-kicker">Gmail</div>
              <div className="text-[15px] font-semibold tracking-[-0.03em]">Intelligence</div>
            </div>
          </div>
          <ul className="mt-3">
            <Status on={diag?.gmailTab === 'connected'} label={diag?.gmailTab === 'connected' ? 'Gmail connected' : 'Gmail not connected'} />
            <Status on={aiReady || aiOff} label={ai} />
            <Status on={trackingReady} label={tracking} />
          </ul>
          <div className="mt-4 grid gap-2">
            <button type="button" className="gi-btn gi-btn-block" onClick={() => chrome.tabs.create({ url: 'https://mail.google.com/' })}>
              Open Gmail
            </button>
            <button type="button" className="gi-btn gi-btn-ghost gi-btn-block" onClick={() => void openInbox()}>
              Open Inbox Intelligence
            </button>
            <button type="button" className="gi-btn gi-btn-ghost gi-btn-block" onClick={() => chrome.runtime.openOptionsPage()}>
              Settings
            </button>
          </div>
          <p className="gi-hint">⌘K in Gmail opens commands</p>
        </div>
      </div>
    </div>
  );
}

function Status(props: { on: boolean; label: string }) {
  return (
    <li className="gi-status">
      <span className={props.on ? 'gi-dot' : 'gi-dot is-quiet'} />
      <span>{props.label}</span>
    </li>
  );
}

async function openInbox(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId != null) {
    await chrome.runtime.sendMessage({ type: 'FOCUS_SIDEPANEL', mode: 'inbox' });
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}
