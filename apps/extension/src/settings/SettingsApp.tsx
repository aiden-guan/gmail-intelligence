import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, type ExtensionSettings, type ThreadCategory } from '@gi/shared';
import { trackerPermissionOrigin } from '@gi/tracking';
import { AiConnect } from '../setup/AiConnect';

const CATEGORIES: ThreadCategory[] = ['RESPOND', 'WAITING', 'FYI', 'NOTIFICATIONS', 'PROMOTIONS', 'NEWS'];

export function SettingsApp() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [changeAi, setChangeAi] = useState(false);
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);
  const [rules, setRules] = useState('');

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res?: { settings?: ExtensionSettings }) => {
      if (res?.settings) setSettings({ ...DEFAULT_SETTINGS, ...res.settings });
    });
  }, []);

  function update<K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  const patchSettings = useCallback((partial: Partial<ExtensionSettings>) => {
    setSettings((current) => ({ ...current, ...partial }));
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: partial }, () => setSaved(true));
  }, []);

  function save() {
    const origin = trackerPermissionOrigin(settings.trackerBaseUrl);
    const persist = () => {
      chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, (res?: { settings?: ExtensionSettings }) => {
        if (res?.settings) {
          setSettings(res.settings);
          setSaved(true);
        }
      });
    };
    if (origin && chrome.permissions?.request) {
      chrome.permissions.request({ origins: [origin] }, () => persist());
      return;
    }
    persist();
  }

  const provider = settings.aiMode === 'disabled'
    ? 'Off'
    : settings.aiProvider === 'chatgpt'
      ? 'ChatGPT (experimental)'
      : settings.aiProvider === 'chrome'
        ? 'On this computer'
        : settings.aiProvider === 'local'
          ? 'Downloaded model'
          : settings.aiProvider;

  return (
    <div className="mx-auto max-w-xl px-6 py-8 text-[#202124]">
      <header className="mb-6">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#5f6368]">Gmail Intelligence</div>
        <h1 className="mt-1 text-xl font-medium">Settings</h1>
      </header>

      <Section title="General">
        <Toggle label="AI Inbox" checked={settings.aiMode !== 'disabled' && settings.autoClassify} onChange={(on) => update('autoClassify', on)} />
        <Toggle label="Email tracking" checked={settings.trackingEnabled} onChange={(on) => update('trackingEnabled', on)} />
        <Toggle label="Desktop alerts" checked={settings.desktopNotifications} onChange={(on) => update('desktopNotifications', on)} />
      </Section>

      <Section title="Agent">
        <Toggle label="Organize inbox automatically" checked={settings.autoClassify} onChange={(on) => update('autoClassify', on)} />
        <Toggle label="Generate reply drafts" checked={settings.autoDraft} onChange={(on) => update('autoDraft', on)} />
        <Toggle label="Follow-up reminders" checked={settings.autoReminders} onChange={(on) => update('autoReminders', on)} />
        <Toggle label="Auto archive low-priority mail" checked={settings.autoArchive} onChange={(on) => update('autoArchive', on)} />
        <p className="text-xs text-[#5f6368]">Drafts stay local until you click Draft reply. Nothing is sent automatically.</p>
      </Section>

      <Section title="AI">
        <p className="text-sm">{provider}{settings.aiModel ? ` · ${settings.aiModel}` : ''}</p>
        <button className="mt-2 text-sm text-[#1a73e8]" onClick={() => setChangeAi((open) => !open)}>
          {changeAi ? 'Hide AI setup' : 'Change AI'}
        </button>
        {changeAi ? <div className="mt-3"><AiConnect settings={settings} onPatch={patchSettings} onSignedIn={patchSettings} /></div> : null}
      </Section>

      <Section title="Email tracking">
        <Toggle label="Track opens" checked={settings.trackOpens} onChange={(on) => update('trackOpens', on)} />
        <Toggle label="Track links" checked={settings.trackLinks} onChange={(on) => update('trackLinks', on)} />
        <p className="text-xs text-[#5f6368]">
          Connection: {settings.trackerBaseUrl && settings.personalApiToken ? 'Configured' : 'Needs setup'}
        </p>
      </Section>

      <Section title="Personalization">
        <Field label="Greeting">
          <input className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" value={settings.voiceProfile.greeting} onChange={(event) => update('voiceProfile', { ...settings.voiceProfile, greeting: event.target.value })} />
        </Field>
        <Field label="Signoff">
          <input className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" value={settings.voiceProfile.signoff} onChange={(event) => update('voiceProfile', { ...settings.voiceProfile, signoff: event.target.value })} />
        </Field>
        <Field label="Concision">
          <select className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" value={settings.voiceProfile.concision} onChange={(event) => update('voiceProfile', { ...settings.voiceProfile, concision: event.target.value as ExtensionSettings['voiceProfile']['concision'] })}>
            <option value="short">Short</option>
            <option value="medium">Medium</option>
            <option value="long">Long</option>
          </select>
        </Field>
        <Field label="Formality">
          <select className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" value={settings.voiceProfile.formality} onChange={(event) => update('voiceProfile', { ...settings.voiceProfile, formality: event.target.value as ExtensionSettings['voiceProfile']['formality'] })}>
            <option value="casual">Casual</option>
            <option value="neutral">Neutral</option>
            <option value="formal">Formal</option>
          </select>
        </Field>
        <Field label="Custom instructions">
          <textarea className="min-h-[5rem] w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" value={settings.voiceProfile.personalInstructions} onChange={(event) => update('voiceProfile', { ...settings.voiceProfile, personalInstructions: event.target.value })} />
        </Field>
      </Section>

      <button className="rounded bg-[#1a73e8] px-3 py-2 text-sm text-white" onClick={save}>
        {saved ? 'Saved' : 'Save'}
      </button>

      <button className="ml-3 text-sm text-[#1a73e8]" onClick={() => setAdvanced((open) => !open)}>
        {advanced ? 'Hide advanced' : 'Advanced'}
      </button>

      {advanced ? (
        <Section title="Advanced">
          <p className="text-xs text-[#5f6368]">
            Provider endpoints, tokens, index controls, and diagnostics. For a local tracker, run npm run tracker and paste the URL and token from .local/tracker.txt.
          </p>
          <Field label="Tracker base URL">
            <input className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" value={settings.trackerBaseUrl} placeholder="https://your-tracker.example" onChange={(event) => update('trackerBaseUrl', event.target.value)} />
          </Field>
          <Field label="Personal API token">
            <input className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" type="password" value={settings.personalApiToken} onChange={(event) => update('personalApiToken', event.target.value)} />
          </Field>
          <Field label="AI endpoint">
            <input className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" value={settings.aiEndpoint} onChange={(event) => update('aiEndpoint', event.target.value)} />
          </Field>
          <Field label="AI API key">
            <input className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" type="password" value={settings.aiApiKey} onChange={(event) => update('aiApiKey', event.target.value)} />
          </Field>
          <Field label="InboxSDK app ID">
            <input className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" value={settings.inboxSdkAppId} onChange={(event) => update('inboxSdkAppId', event.target.value)} />
          </Field>
          <Field label="Archive confidence">
            <input className="w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" type="number" min={0} max={1} step={0.01} value={settings.archiveConfidenceThreshold} onChange={(event) => update('archiveConfidenceThreshold', Number(event.target.value))} />
          </Field>
          <Toggle label="Insert generated drafts into Gmail automatically" checked={settings.autoInsertDraft} onChange={(on) => update('autoInsertDraft', on)} />
          <Toggle label="Command palette" checked={settings.commandPaletteEnabled} onChange={(on) => update('commandPaletteEnabled', on)} />
          <Toggle label="Command palette overrides Gmail shortcuts" checked={settings.commandPaletteOverrideGmail} onChange={(on) => update('commandPaletteOverrideGmail', on)} />
          <div className="text-xs text-[#5f6368]">Archive categories</div>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((category) => (
              <label key={category} className="text-xs">
                <input
                  type="checkbox"
                  checked={settings.archiveCategories.includes(category)}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...settings.archiveCategories, category]
                      : settings.archiveCategories.filter((item) => item !== category);
                    update('archiveCategories', next);
                  }}
                />{' '}
                {category}
              </label>
            ))}
          </div>
          <Field label="Agent rules, one per line">
            <textarea className="min-h-[5rem] w-full rounded border border-[#dadce0] px-2 py-1 text-sm text-[#202124]" value={rules} onChange={(event) => setRules(event.target.value)} />
          </Field>
          <button
            className="text-sm text-[#1a73e8]"
            onClick={() => chrome.runtime.sendMessage({ type: 'SAVE_AGENT_RULES', lines: rules.split('\n').map((line) => line.trim()).filter(Boolean) })}
          >
            Save rules
          </button>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="rounded border border-[#dadce0] px-2 py-1 text-xs" onClick={() => chrome.runtime.sendMessage({ type: 'INDEX_INBOX', mode: '30d' })}>Index older messages</button>
            <button className="rounded border border-[#dadce0] px-2 py-1 text-xs" onClick={() => chrome.runtime.sendMessage({ type: 'PAUSE_INDEX' })}>Pause</button>
            <button className="rounded border border-[#dadce0] px-2 py-1 text-xs" onClick={() => chrome.runtime.sendMessage({ type: 'CLEAR_INDEX' })}>Clear local mail index</button>
            <button className="rounded border border-[#dadce0] px-2 py-1 text-xs" onClick={() => chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (next) => setDiag(next))}>Run diagnostics</button>
          </div>
          {diag ? <pre className="mt-3 overflow-auto rounded bg-[#f6f7f8] p-2 text-[11px]">{JSON.stringify(diag, null, 2)}</pre> : null}
          <p className="text-xs text-[#5f6368]">ChatGPT web sign-in is experimental and may stop working when ChatGPT’s website changes.</p>
        </Section>
      ) : null}
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6 border-b border-[#e8eaed] pb-4">
      <h2 className="mb-2 text-sm font-medium">{props.title}</h2>
      <div className="space-y-2">{props.children}</div>
    </section>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{props.label}</span>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
    </label>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs text-[#5f6368]">
      {props.label}
      <div className="mt-1">{props.children}</div>
    </label>
  );
}
