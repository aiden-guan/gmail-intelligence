import { useCallback, useEffect, useState } from 'react';
import type { ExtensionSettings } from '@gi/shared';
import { DEFAULT_SETTINGS } from '@gi/shared';

type SplitCategory =
  | 'PRIORITY'
  | 'RESPOND'
  | 'WAITING'
  | 'FYI'
  | 'NOTIFICATIONS'
  | 'PROMOTIONS'
  | 'NEWS'
  | 'FOLLOW_UPS';

type SplitThread = {
  threadId: string;
  subject: string;
  sender: string;
  snippet: string;
  timestamp: string;
  priority?: string;
  manual?: boolean;
};

type AskResult = {
  answer?: string;
  citations?: Array<{ threadId: string; subject: string }>;
  coverageNote?: string;
  error?: string;
};

const CATEGORIES: Array<[SplitCategory, string]> = [
  ['PRIORITY', 'Priority'],
  ['RESPOND', 'Respond'],
  ['WAITING', 'Waiting'],
  ['FYI', 'FYI'],
  ['NOTIFICATIONS', 'Notifications'],
  ['PROMOTIONS', 'Promotions'],
  ['NEWS', 'News'],
  ['FOLLOW_UPS', 'Follow-ups'],
];

export function SidePanelApp() {
  const [mode, setMode] = useState<'inbox' | 'ask'>('inbox');
  const [category, setCategory] = useState<SplitCategory>('RESPOND');
  const [threads, setThreads] = useState<SplitThread[]>([]);
  const [coverage, setCoverage] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);

  const loadSplit = useCallback((next: SplitCategory) => {
    chrome.runtime.sendMessage({ type: 'LIST_SPLIT', category: next }, (res?: { threads?: SplitThread[] }) => {
      setThreads(res?.threads || []);
    });
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res?: { settings?: ExtensionSettings }) => {
      if (res?.settings) setSettings({ ...DEFAULT_SETTINGS, ...res.settings });
    });
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (diag?: { coverage?: string }) => {
      if (diag?.coverage) setCoverage(diag.coverage);
    });
    chrome.storage.session.get('panelState', (stored) => {
      const state = stored.panelState as { mode?: 'inbox' | 'ask'; splitCategory?: SplitCategory } | undefined;
      if (state?.mode) setMode(state.mode);
      if (state?.splitCategory) {
        setCategory(state.splitCategory);
        loadSplit(state.splitCategory);
      } else loadSplit('RESPOND');
    });
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'session') return;
      if (changes.panelState?.newValue) {
        const state = changes.panelState.newValue as { mode?: 'inbox' | 'ask'; splitCategory?: SplitCategory };
        if (state.mode) setMode(state.mode);
        if (state.splitCategory) {
          setCategory(state.splitCategory);
          loadSplit(state.splitCategory);
        }
      }
      if (changes.intelPulse) loadSplit(category);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [category, loadSplit]);

  function choose(next: SplitCategory) {
    setCategory(next);
    setMode('inbox');
    chrome.storage.session.set({ panelState: { mode: 'inbox', splitCategory: next } });
    loadSplit(next);
  }

  function ask() {
    if (!query.trim()) return;
    setLoading(true);
    chrome.runtime.sendMessage({ type: 'ASK_INBOX', query }, (res: AskResult) => {
      setResult(res || { error: 'No response' });
      setLoading(false);
    });
  }

  const label = CATEGORIES.find((item) => item[0] === category)?.[1] || 'Inbox';

  return (
    <div className="flex h-full flex-col bg-white text-[#202124]">
      <header className="border-b border-[#e8eaed] px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#5f6368]">Gmail Intelligence</div>
        <div className="mt-2 flex gap-1">
          <Tab active={mode === 'inbox'} onClick={() => setMode('inbox')}>Inbox</Tab>
          <Tab active={mode === 'ask'} onClick={() => { setMode('ask'); chrome.storage.session.set({ panelState: { mode: 'ask', splitCategory: category } }); }}>Ask</Tab>
        </div>
      </header>
      {mode === 'inbox' ? (
        <div className="flex min-h-0 flex-1">
          <nav className="w-[132px] shrink-0 border-r border-[#e8eaed] py-2">
            {CATEGORIES.map(([id, name]) => (
              <button
                key={id}
                className={`block w-full px-3 py-1.5 text-left text-[13px] ${id === category ? 'bg-[#e8f0fe] font-medium text-[#174ea6]' : 'text-[#3c4043]'}`}
                onClick={() => choose(id)}
              >
                {name}
              </button>
            ))}
          </nav>
          <main className="min-w-0 flex-1 overflow-auto">
            <div className="px-3 py-2 text-[12px] text-[#5f6368]">{label} · {threads.length}</div>
            {threads.length === 0 ? (
              <p className="px-3 text-[13px] text-[#5f6368]">Nothing here yet. Threads appear after Gmail loads them.</p>
            ) : (
              <ul>
                {threads.map((thread) => (
                  <li key={thread.threadId}>
                    <button className="block w-full px-3 py-2 text-left hover:bg-[#f6f7f8]" onClick={() => openThread(thread.threadId)}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13px] font-medium">{thread.sender}</span>
                        <span className="shrink-0 text-[11px] text-[#5f6368]">{when(thread.timestamp)}</span>
                      </div>
                      <div className="truncate text-[13px]">{thread.subject || '(no subject)'}</div>
                      <div className="truncate text-[12px] text-[#5f6368]">
                        {thread.snippet || ''}
                        {thread.manual ? ' · Manual' : ''}
                        {thread.priority === 'HIGH' ? ' · Priority' : ''}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </main>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex gap-2 border-b border-[#e8eaed] p-3">
            <input
              className="min-w-0 flex-1 rounded border border-[#dadce0] px-2 py-1.5 text-[13px]"
              placeholder="Ask about mail on this computer"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && ask()}
            />
            <button className="rounded bg-[#1a73e8] px-3 text-[13px] text-white" disabled={loading} onClick={ask}>
              {loading ? '…' : 'Ask'}
            </button>
          </div>
          <div className="flex-1 overflow-auto p-3 text-[13px]">
            {coverage ? <p className="mb-3 text-[12px] text-[#5f6368]">{coverage}</p> : null}
            {settings.aiMode === 'disabled' ? (
              <p className="mb-3 text-[12px] text-[#5f6368]">AI is off. Results are local matches.</p>
            ) : null}
            {result?.error ? <p className="text-red-700">{result.error}</p> : null}
            {result?.answer ? <p className="whitespace-pre-wrap">{result.answer}</p> : null}
            {result?.citations?.length ? (
              <ul className="mt-3 space-y-1">
                {result.citations.map((citation) => (
                  <li key={citation.threadId}>
                    <button className="text-left text-[#1a73e8]" onClick={() => openThread(citation.threadId)}>
                      {citation.subject || citation.threadId}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function Tab(props: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      className={`rounded px-2 py-1 text-[13px] ${props.active ? 'bg-[#e8f0fe] font-medium text-[#174ea6]' : 'text-[#3c4043]'}`}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function when(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const delta = Date.now() - time;
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

async function openThread(threadId: string): Promise<void> {
  const url = `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && tab.url?.includes('mail.google.com')) {
    await chrome.tabs.update(tab.id, { url });
    return;
  }
  const gmail = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  const foreground = gmail.find((item) => item.active && !item.pinned) || gmail.find((item) => !item.pinned);
  if (foreground?.id) await chrome.tabs.update(foreground.id, { url, active: true });
  else await chrome.tabs.create({ url });
}
