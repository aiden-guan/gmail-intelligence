import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type ExtensionSettings, type ThreadCategory } from '@gi/shared';
import { AiConnect } from '../setup/AiConnect';

const CATEGORIES: ThreadCategory[] = [
  'RESPOND',
  'WAITING',
  'FYI',
  'NOTIFICATIONS',
  'PROMOTIONS',
  'NEWS',
];

export function SettingsApp() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);
  const [activity, setActivity] = useState<Array<{ id: string; type: string; detail: string; createdAt: number }>>([]);
  const [coverage, setCoverage] = useState('');

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
      if (res?.settings) setSettings({ ...DEFAULT_SETTINGS, ...res.settings });
    });
    chrome.runtime.sendMessage({ type: 'GET_ACTIVITY_LOG' }, (res) => {
      if (res?.actions) setActivity(res.actions);
    });
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (d) => {
      if (d?.coverage) setCoverage(String(d.coverage));
    });
  }, []);

  function update<K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  }

  const patchSettings = useCallback((partial: Partial<ExtensionSettings>) => {
    setSettings((current) => ({ ...current, ...partial }));
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: partial }, () => {
      setSaved(true);
    });
  }, []);

  const applySignedIn = useCallback((partial: Partial<ExtensionSettings>) => {
    setSettings((current) => ({ ...current, ...partial }));
    setSaved(true);
  }, []);

  useEffect(() => {
    if (location.hash !== '#ai-setup') return;
    document.getElementById('ai-setup')?.scrollIntoView({ block: 'start' });
  }, []);

  function save() {
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, (res) => {
      if (res?.settings) {
        setSettings(res.settings);
        setSaved(true);
      }
    });
  }

  function runDiag() {
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (d) => setDiag(d));
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#5b6b7c]">
          Gmail Intelligence
        </div>
        <h1 className="mt-1 text-2xl font-semibold">Settings</h1>
        <p className="mt-2 text-sm text-[#5b6b7c]">
          Sign in with ChatGPT or download a model. Mailbox contents never go to the tracker.
        </p>
      </header>

      <Section title="AI">
        <AiConnect settings={settings} onPatch={patchSettings} onSignedIn={applySignedIn} />
      </Section>

      <Section title="Tracking">
        <Toggle
          label="Enable open/click tracking"
          checked={settings.trackingEnabled}
          onChange={(v) => update('trackingEnabled', v)}
        />
        <Toggle label="Track opens" checked={settings.trackOpens} onChange={(v) => update('trackOpens', v)} />
        <Toggle label="Track links" checked={settings.trackLinks} onChange={(v) => update('trackLinks', v)} />
        <Toggle
          label="Desktop notifications"
          checked={settings.desktopNotifications}
          onChange={(v) => update('desktopNotifications', v)}
        />
        <Toggle
          label="Hide suspected self-opens"
          checked={settings.hideSuspectedSelfOpens}
          onChange={(v) => update('hideSuspectedSelfOpens', v)}
        />
        <Field label="Tracker base URL">
          <input
            className="field"
            value={settings.trackerBaseUrl}
            placeholder="https://your-tracker.example.workers.dev"
            onChange={(e) => update('trackerBaseUrl', e.target.value)}
          />
        </Field>
        <Field label="Personal API token">
          <input
            className="field"
            type="password"
            value={settings.personalApiToken}
            onChange={(e) => update('personalApiToken', e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Inbox Agent">
        <Toggle label="Auto classify" checked={settings.autoClassify} onChange={(v) => update('autoClassify', v)} />
        <Toggle label="Auto summarize" checked={settings.autoSummarize} onChange={(v) => update('autoSummarize', v)} />
        <Toggle
          label="Auto drafts (draft only, never auto-send)"
          checked={settings.autoDraft}
          onChange={(v) => update('autoDraft', v)}
        />
        <Toggle label="Auto reminders" checked={settings.autoReminders} onChange={(v) => update('autoReminders', v)} />
        <Toggle label="Auto archive" checked={settings.autoArchive} onChange={(v) => update('autoArchive', v)} />
        <Field label="Reminder mode">
          <select
            className="field"
            value={settings.reminderMode}
            onChange={(e) =>
              update('reminderMode', e.target.value as ExtensionSettings['reminderMode'])
            }
          >
            <option value="ai_needed">Only when follow-up likely needed</option>
            <option value="every_external">Every external outbound</option>
            <option value="disabled">Disabled</option>
          </select>
        </Field>
        <Field label="Reminder delay (business days)">
          <input
            className="field"
            type="number"
            min={1}
            max={30}
            value={settings.reminderBusinessDays}
            onChange={(e) => update('reminderBusinessDays', Number(e.target.value))}
          />
        </Field>
        <Field label="InboxSDK App ID (optional)">
          <input
            className="field"
            value={settings.inboxSdkAppId}
            onChange={(e) => update('inboxSdkAppId', e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Auto Archive">
        <p className="mb-2 text-xs text-[#5b6b7c]">
          Default eligible: NOTIFICATIONS, PROMOTIONS, NEWS. Never default-archive RESPOND, WAITING, FYI.
        </p>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={settings.archiveCategories.includes(c)}
                disabled={c === 'RESPOND' || c === 'WAITING' || c === 'FYI'}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...settings.archiveCategories, c]
                    : settings.archiveCategories.filter((x) => x !== c);
                  update('archiveCategories', next);
                }}
              />
              {c}
            </label>
          ))}
        </div>
        <Field label="Confidence threshold">
          <input
            className="field"
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={settings.archiveConfidenceThreshold}
            onChange={(e) => update('archiveConfidenceThreshold', Number(e.target.value))}
          />
        </Field>
        <Field label="Always archive senders/domains (comma-separated)">
          <input
            className="field"
            value={settings.alwaysArchiveSenders.join(', ')}
            onChange={(e) =>
              update(
                'alwaysArchiveSenders',
                e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              )
            }
          />
        </Field>
        <Field label="Never archive senders/domains (comma-separated)">
          <input
            className="field"
            value={settings.neverArchiveSenders.join(', ')}
            onChange={(e) =>
              update(
                'neverArchiveSenders',
                e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              )
            }
          />
        </Field>
      </Section>

      <Section title="Personalization">
        <Field label="Greeting">
          <input
            className="field"
            value={settings.voiceProfile.greeting}
            onChange={(e) =>
              update('voiceProfile', { ...settings.voiceProfile, greeting: e.target.value })
            }
          />
        </Field>
        <Field label="Sign-off">
          <input
            className="field"
            value={settings.voiceProfile.signoff}
            onChange={(e) =>
              update('voiceProfile', { ...settings.voiceProfile, signoff: e.target.value })
            }
          />
        </Field>
        <Field label="Formality">
          <select
            className="field"
            value={settings.voiceProfile.formality}
            onChange={(e) =>
              update('voiceProfile', {
                ...settings.voiceProfile,
                formality: e.target.value as 'casual' | 'neutral' | 'formal',
              })
            }
          >
            <option value="casual">Casual</option>
            <option value="neutral">Neutral</option>
            <option value="formal">Formal</option>
          </select>
        </Field>
        <Field label="Personal instructions">
          <textarea
            className="field min-h-[80px]"
            value={settings.voiceProfile.personalInstructions}
            onChange={(e) =>
              update('voiceProfile', {
                ...settings.voiceProfile,
                personalInstructions: e.target.value,
              })
            }
          />
        </Field>
        <Toggle
          label="Learn style from sampled sent mail (not continuous full mailbox)"
          checked={settings.learnFromSent}
          onChange={(v) => update('learnFromSent', v)}
        />
      </Section>

      <Section title="Index">
        <p className="mb-2 text-sm text-[#5b6b7c]">{coverage || 'Coverage unknown'}</p>
        <div className="flex flex-wrap gap-2">
          {(['7d', '30d', '90d', '1y', 'sent_sample'] as const).map((mode) => (
            <button
              key={mode}
              className="rounded border border-[#d3dae2] bg-white px-3 py-1.5 text-sm"
              onClick={() => chrome.runtime.sendMessage({ type: 'INDEX_INBOX', mode })}
            >
              Index {mode}
            </button>
          ))}
          <button
            className="rounded border border-[#d3dae2] bg-white px-3 py-1.5 text-sm"
            onClick={() => chrome.runtime.sendMessage({ type: 'PAUSE_INDEX' })}
          >
            Pause
          </button>
          <button
            className="rounded border border-[#d3dae2] bg-white px-3 py-1.5 text-sm"
            onClick={() => chrome.runtime.sendMessage({ type: 'RESUME_INDEX' })}
          >
            Resume
          </button>
          <button
            className="rounded border border-red-200 bg-white px-3 py-1.5 text-sm text-red-700"
            onClick={() => {
              if (confirm('Clear local mailbox index?')) {
                chrome.runtime.sendMessage({ type: 'CLEAR_INDEX' });
              }
            }}
          >
            Clear index
          </button>
        </div>
      </Section>

      <Section title="Privacy">
        <button
          className="rounded border border-[#d3dae2] bg-white px-3 py-1.5 text-sm"
          onClick={() => chrome.runtime.sendMessage({ type: 'CLEAR_AI_CACHE' })}
        >
          Clear AI cache
        </button>
        <button
          className="ml-2 rounded border border-[#d3dae2] bg-white px-3 py-1.5 text-sm"
          onClick={() => {
            update('voiceProfile', DEFAULT_SETTINGS.voiceProfile);
          }}
        >
          Reset style profile
        </button>
      </Section>

      <Section title="Agent rules">
        <p className="mb-2 text-xs text-[#5b6b7c]">
          Examples: &quot;never archive berkeley.edu&quot;, &quot;always treat ycombinator.com as important&quot;.
          Explicit rules override AI.
        </p>
        <textarea
          className="field min-h-[100px]"
          id="gi-rules"
          placeholder={'never archive berkeley.edu\nalways archive newsletters.example.com'}
          defaultValue=""
        />
        <button
          className="mt-2 rounded border border-[#d3dae2] bg-white px-3 py-1.5 text-sm"
          onClick={() => {
            const el = document.getElementById('gi-rules') as HTMLTextAreaElement | null;
            const lines = (el?.value || '')
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean);
            chrome.runtime.sendMessage({ type: 'SAVE_AGENT_RULES', lines }, () => {
              setSaved(true);
            });
          }}
        >
          Save rules
        </button>
      </Section>

      <Section title="Diagnostics">
        <button className="rounded bg-[#1a73e8] px-3 py-1.5 text-sm text-white" onClick={runDiag}>
          Run diagnostics
        </button>
        {diag ? (
          <pre className="mt-3 overflow-auto rounded border border-[#d3dae2] bg-white p-3 text-xs">
            {JSON.stringify(diag, null, 2)}
          </pre>
        ) : null}
      </Section>

      <Section title="Agent activity">
        <ul className="max-h-64 space-y-2 overflow-auto text-sm">
          {activity.map((a) => (
            <li key={a.id} className="rounded border border-[#d3dae2] bg-white px-3 py-2">
              <div className="text-[11px] text-[#5b6b7c]">
                {new Date(a.createdAt).toLocaleString()} · {a.type}
              </div>
              <div>{a.detail}</div>
            </li>
          ))}
          {!activity.length ? <li className="text-[#5b6b7c]">No actions yet.</li> : null}
        </ul>
      </Section>

      <div className="sticky bottom-4 mt-6 flex items-center gap-3">
        <button className="rounded bg-[#1a73e8] px-4 py-2 text-sm font-medium text-white" onClick={save}>
          Save settings
        </button>
        {saved ? <span className="text-sm text-green-700">Saved</span> : null}
      </div>

      <style>{`
        .field { width: 100%; border: 1px solid #d3dae2; border-radius: 6px; padding: 8px 10px; font: inherit; background: #fff; }
      `}</style>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 rounded-lg border border-[#d3dae2] bg-white p-5">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-[#5b6b7c]">{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
