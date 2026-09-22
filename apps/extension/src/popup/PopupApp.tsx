import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@gi/shared';
import { getLocalModel } from '@gi/ai';
import { listDownloadedModelIds } from '../local-model/cache';
import {
  getOnDeviceAvailability,
  type OnDeviceAvailability,
} from '../local-model/chrome-model';

type ChatGptStatus = {
  signedIn: boolean;
  email: string | null;
  planType: string | null;
  lastError: string | null;
};

export function PopupApp() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [account, setAccount] = useState<ChatGptStatus | null>(null);
  const [availability, setAvailability] = useState<OnDeviceAvailability | 'checking'>('checking');
  const [downloadedIds, setDownloadedIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  function refresh(): void {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response?: { settings?: ExtensionSettings }) => {
      if (response?.settings) setSettings({ ...DEFAULT_SETTINGS, ...response.settings });
    });
    chrome.runtime.sendMessage({ type: 'CHATGPT_STATUS' }, (response?: ChatGptStatus) => {
      if (!chrome.runtime.lastError && response) setAccount(response);
    });
    void getOnDeviceAvailability().then(setAvailability);
    void listDownloadedModelIds().then(setDownloadedIds);
  }

  useEffect(() => {
    refresh();
    const onFinished = (message: { type?: string; ok?: boolean; email?: string | null; error?: string }) => {
      if (message?.type !== 'CHATGPT_LOGIN_FINISHED') return;
      setNotice(
        message.ok
          ? message.email
            ? `Signed in as ${message.email}.`
            : 'Signed in with ChatGPT.'
          : message.error || 'ChatGPT sign-in did not finish.',
      );
      refresh();
    };
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    chrome.runtime.onMessage.addListener(onFinished);
    return () => chrome.runtime.onMessage.removeListener(onFinished);
  }, []);

  const usingChatGpt = settings.aiMode !== 'disabled' && settings.aiProvider === 'chatgpt' && account?.signedIn;
  const usingDevice =
    (settings.aiMode === 'local' && settings.aiProvider === 'chrome' && availability === 'available') ||
    (settings.aiMode === 'local' &&
      settings.aiProvider === 'local' &&
      downloadedIds.includes(settings.aiModel));

  return (
    <div className="w-[320px] bg-white p-4 font-sans text-[#141b22]">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#5b6b7c]">
        Gmail Intelligence
      </div>
      <p className="mt-2 text-sm text-[#141b22]">
        {usingChatGpt
          ? accountLabel(account)
          : usingDevice
            ? deviceLabel(settings.aiProvider, settings.aiModel)
            : 'Sign in with ChatGPT, or download a model that stays on this computer.'}
      </p>
      {notice ? <p className="mt-2 text-xs text-[#5b6b7c]">{notice}</p> : null}
      {account?.lastError && usingChatGpt ? (
        <p className="mt-2 text-xs text-red-700">{account.lastError}</p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2">
        {usingChatGpt ? null : (
          <button className="rounded bg-[#1a73e8] px-3 py-2 text-left text-sm font-medium text-white" onClick={signIn}>
            Sign in with ChatGPT
          </button>
        )}
        <button className="rounded border border-[#d3dae2] px-3 py-2 text-left text-sm hover:bg-[#f6f7f8]" onClick={openSetup}>
          {usingDevice
            ? 'Change model'
            : downloadedIds.length > 0 || availability === 'available'
              ? 'Choose a model'
              : 'Download a model'}
        </button>
        <button className="rounded border border-[#d3dae2] px-3 py-2 text-left text-sm hover:bg-[#f6f7f8]" onClick={openAsk}>
          Open Ask Inbox
        </button>
        <button
          className="rounded border border-[#d3dae2] px-3 py-2 text-left text-sm hover:bg-[#f6f7f8]"
          onClick={() => chrome.tabs.create({ url: 'https://mail.google.com/' })}
        >
          Open Gmail
        </button>
      </div>
    </div>
  );

  function signIn() {
    setNotice(null);
    chrome.runtime.sendMessage(
      { type: 'CHATGPT_LOGIN' },
      (response?: { ok?: boolean; error?: string; alreadySignedIn?: boolean; email?: string | null }) => {
        if (chrome.runtime.lastError || !response?.ok) {
          setNotice(response?.error || 'Could not start ChatGPT sign-in.');
        } else if (response.alreadySignedIn) {
          setNotice(response.email ? `Signed in as ${response.email}.` : 'Signed in with ChatGPT.');
        } else {
          setNotice('Continue in the ChatGPT tab.');
        }
      },
    );
  }

  function openSetup() {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/settings/index.html#ai-setup') });
  }

  function openAsk() {
    void chrome.sidePanel.open({ windowId: undefined as unknown as number }).catch(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
    });
  }
}

function deviceLabel(provider: ExtensionSettings['aiProvider'], modelId: string): string {
  if (provider === 'local') {
    const model = getLocalModel(modelId);
    return model ? `${model.label} is ready on this computer.` : 'A downloaded model is ready.';
  }
  return 'Chrome’s built-in model is ready.';
}

function accountLabel(account: ChatGptStatus | null): string {
  if (!account?.signedIn) return 'ChatGPT is ready.';
  const plan = account.planType
    ? account.planType.charAt(0).toUpperCase() + account.planType.slice(1)
    : null;
  if (account.email && plan) return `${account.email} · ${plan}`;
  return account.email || 'Signed in with ChatGPT.';
}
