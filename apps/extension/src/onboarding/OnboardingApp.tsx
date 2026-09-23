import { useState } from 'react';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@gi/shared';

export function OnboardingApp() {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);

  function finish() {
    chrome.storage.local.set({ onboardingComplete: true });
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    chrome.tabs.create({ url: 'https://mail.google.com/' });
    window.close();
  }

  return (
    <div className="mx-auto max-w-md px-6 py-10 text-[#202124]">
      {step === 0 ? (
        <>
          <h1 className="text-xl font-medium">Gmail Intelligence</h1>
          <p className="mt-3 text-sm text-[#5f6368]">Your inbox can now:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            <li>organize mail</li>
            <li>summarize threads</li>
            <li>draft replies</li>
            <li>remind you to follow up</li>
            <li>track sent email</li>
          </ul>
          <button className="mt-6 rounded bg-[#1a73e8] px-3 py-2 text-sm text-white" onClick={() => setStep(1)}>Continue</button>
        </>
      ) : null}
      {step === 1 ? (
        <>
          <h1 className="text-xl font-medium">Choose AI</h1>
          <div className="mt-4 flex flex-col gap-2">
            <button className="rounded border border-[#dadce0] px-3 py-2 text-left text-sm" onClick={() => { setSettings({ ...settings, aiMode: 'local', aiProvider: 'chrome', aiModel: 'gemini-nano' }); setStep(2); }}>On this computer</button>
            <button className="rounded border border-[#dadce0] px-3 py-2 text-left text-sm" onClick={() => { setSettings({ ...settings, aiMode: 'remote', aiProvider: 'openai' }); setStep(2); }}>API provider</button>
            <button className="rounded border border-[#dadce0] px-3 py-2 text-left text-sm" onClick={() => { setSettings({ ...settings, aiMode: 'disabled' }); setStep(2); }}>Skip for now</button>
          </div>
        </>
      ) : null}
      {step === 2 ? (
        <>
          <h1 className="text-xl font-medium">Email tracking</h1>
          <p className="mt-3 text-sm text-[#5f6368]">Tracking requires a public tracking endpoint.</p>
          <div className="mt-4 flex flex-col gap-2">
            <button className="rounded border border-[#dadce0] px-3 py-2 text-left text-sm" onClick={() => chrome.runtime.openOptionsPage()}>Configure now</button>
            <button className="rounded border border-[#dadce0] px-3 py-2 text-left text-sm" onClick={() => setStep(3)}>Skip for now</button>
          </div>
        </>
      ) : null}
      {step === 3 ? (
        <>
          <h1 className="text-xl font-medium">Ready</h1>
          <p className="mt-3 text-sm text-[#5f6368]">Open Gmail. Categories and summaries show up as you read.</p>
          <button className="mt-6 rounded bg-[#1a73e8] px-3 py-2 text-sm text-white" onClick={finish}>Open Gmail</button>
        </>
      ) : null}
    </div>
  );
}
