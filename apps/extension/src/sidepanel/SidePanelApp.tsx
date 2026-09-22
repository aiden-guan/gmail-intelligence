import { useEffect, useState } from 'react';

type AskResult = {
  answer?: string;
  citations?: Array<{ threadId: string; subject: string }>;
  incompleteIndex?: boolean;
  coverageNote?: string;
  error?: string;
};

export function SidePanelApp() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [coverage, setCoverage] = useState('');

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (d) => {
      if (d?.coverage) setCoverage(d.coverage);
    });
  }, []);

  async function ask() {
    if (!query.trim()) return;
    setLoading(true);
    setResult(null);
    chrome.runtime.sendMessage({ type: 'ASK_INBOX', query }, (res: AskResult) => {
      setResult(res || { error: 'No response' });
      setLoading(false);
    });
  }

  return (
    <div className="flex h-full flex-col bg-[#f6f7f8]">
      <header className="border-b border-[#d3dae2] bg-white px-4 py-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#5b6b7c]">
          Gmail Intelligence
        </div>
        <h1 className="mt-0.5 text-lg font-semibold text-[#141b22]">Ask Inbox</h1>
        <p className="mt-1 text-xs text-[#5b6b7c]">
          Answers use your local index only. Every factual result links to threads.
        </p>
        {coverage ? (
          <p className="mt-2 rounded bg-[#e8f0fe] px-2 py-1.5 text-[11px] text-[#174ea6]">
            {coverage}
          </p>
        ) : null}
      </header>

      <div className="flex gap-2 border-b border-[#d3dae2] bg-white p-3">
        <input
          className="min-w-0 flex-1 rounded border border-[#d3dae2] px-3 py-2 text-sm"
          placeholder="What needs a response?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void ask()}
        />
        <button
          className="rounded bg-[#1a73e8] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          disabled={loading}
          onClick={() => void ask()}
        >
          {loading ? '…' : 'Ask'}
        </button>
      </div>

      <main className="flex-1 overflow-auto p-4">
        {result?.error ? (
          <p className="text-sm text-red-700">{result.error}</p>
        ) : null}
        {result?.answer ? (
          <div className="space-y-3">
            {result.incompleteIndex ? (
              <p className="text-xs text-[#8a6116]">
                Local index may be incomplete — Ask Inbox never claims it searched unindexed mail.
              </p>
            ) : null}
            <div className="whitespace-pre-wrap rounded border border-[#d3dae2] bg-white p-3 text-sm leading-relaxed">
              {result.answer}
            </div>
            {result.citations?.length ? (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[#5b6b7c]">
                  Supporting threads
                </div>
                <ul className="space-y-1">
                  {result.citations.map((c) => (
                    <li key={c.threadId}>
                      <button
                        className="text-left text-sm text-[#1a73e8] hover:underline"
                        onClick={() => {
                          chrome.tabs.create({
                            url: `https://mail.google.com/mail/u/0/#all/${c.threadId}`,
                          });
                        }}
                      >
                        {c.subject || c.threadId}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-[#5b6b7c]">
            <p className="mb-2">Try:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>What needs a response?</li>
              <li>Who am I waiting on?</li>
              <li>Find email from Sarah</li>
              <li>What did I promise this week?</li>
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}
