export function PopupApp() {
  return (
    <div className="w-[300px] bg-white p-4 font-sans text-[#141b22]">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#5b6b7c]">
        Gmail Intelligence
      </div>
      <p className="mt-2 text-sm text-[#5b6b7c]">
        Local inbox intelligence and open tracking. No Gmail API.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        <button
          className="rounded border border-[#d3dae2] px-3 py-2 text-left text-sm hover:bg-[#f6f7f8]"
          onClick={() => {
            void chrome.sidePanel.open({ windowId: undefined as unknown as number }).catch(async () => {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (tab?.windowId != null) {
                await chrome.sidePanel.open({ windowId: tab.windowId });
              }
            });
          }}
        >
          Open Ask Inbox
        </button>
        <button
          className="rounded border border-[#d3dae2] px-3 py-2 text-left text-sm hover:bg-[#f6f7f8]"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          Settings
        </button>
        <button
          className="rounded border border-[#d3dae2] px-3 py-2 text-left text-sm hover:bg-[#f6f7f8]"
          onClick={() => {
            chrome.tabs.create({ url: 'https://mail.google.com/' });
          }}
        >
          Open Gmail
        </button>
      </div>
    </div>
  );
}
