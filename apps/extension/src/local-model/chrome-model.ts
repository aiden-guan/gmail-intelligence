export type OnDeviceAvailability =
  | 'unsupported'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

type DownloadEvent = Event & { loaded?: number; total?: number };

type ModelSession = {
  prompt: (input: string) => Promise<string>;
  destroy: () => void;
};

type ChromeModelOptions = {
  expectedInputs?: Array<{ type: 'text'; languages: string[] }>;
  expectedOutputs?: Array<{ type: 'text'; languages: string[] }>;
  /** Older Chrome builds read this instead of expectedOutputs. */
  outputLanguage?: string;
  monitor?: (monitor: EventTarget) => void;
  initialPrompts?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
};

/** Chrome rejects LanguageModel calls that omit a supported output language. */
export const chromeModelOptions: ChromeModelOptions = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
  outputLanguage: 'en',
};

type ModelFactory = {
  availability: (options?: ChromeModelOptions) => Promise<OnDeviceAvailability>;
  create: (options?: ChromeModelOptions) => Promise<ModelSession>;
};

const HARDWARE_HINT =
  'On-device AI needs desktop Chrome 138 or newer, about 16 GB of memory, and 22 GB of free disk.';

let promptChain: Promise<void> = Promise.resolve();

export function getLanguageModel(): ModelFactory | null {
  const host = globalThis as typeof globalThis & {
    LanguageModel?: ModelFactory;
    ai?: { languageModel?: ModelFactory };
  };
  return host.LanguageModel ?? host.ai?.languageModel ?? null;
}

export async function getOnDeviceAvailability(): Promise<OnDeviceAvailability> {
  const model = getLanguageModel();
  if (!model) return 'unsupported';
  try {
    const status = await model.availability(chromeModelOptions);
    if (
      status === 'available' ||
      status === 'downloadable' ||
      status === 'downloading' ||
      status === 'unavailable'
    ) {
      return status;
    }
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Call directly from a click handler so Chrome still sees the user gesture. */
export function startOnDeviceDownload(onProgress: (fraction: number) => void): Promise<void> {
  const model = getLanguageModel();
  if (!model) return Promise.reject(new Error(HARDWARE_HINT));
  let pending: Promise<ModelSession>;
  try {
    pending = model.create({
      ...chromeModelOptions,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          onProgress(progressFraction(event as DownloadEvent));
        });
      },
    });
  } catch (error) {
    return Promise.reject(normalizeModelError(error));
  }
  return pending.then(
    (session) => {
      session.destroy();
      onProgress(1);
    },
    (error: unknown) => {
      throw normalizeModelError(error);
    },
  );
}

export function promptWithChromeModel(system: string, user: string): Promise<string> {
  const run = promptChain.then(() => runPrompt(system, user));
  promptChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function onDeviceUnavailableMessage(status: OnDeviceAvailability): string {
  if (status === 'unsupported' || status === 'unavailable') return HARDWARE_HINT;
  return '';
}

async function runPrompt(system: string, user: string): Promise<string> {
  const model = getLanguageModel();
  if (!model) throw new Error(HARDWARE_HINT);
  const availability = await model.availability(chromeModelOptions);
  if (availability !== 'available') {
    throw new Error('Download the on-device model in Settings.');
  }
  const session = await model.create({
    ...chromeModelOptions,
    initialPrompts: system ? [{ role: 'system', content: system }] : undefined,
  });
  try {
    const text = await session.prompt(user.slice(0, 8000));
    if (!text.trim()) throw new Error('On-device model returned an empty response.');
    return text;
  } catch (error) {
    throw normalizeModelError(error);
  } finally {
    session.destroy();
  }
}

function progressFraction(event: DownloadEvent): number {
  const loaded = event.loaded ?? 0;
  const total = event.total ?? 0;
  const fraction = total > 0 ? loaded / total : loaded > 1 ? 0 : loaded;
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(1, fraction));
}

function normalizeModelError(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'On-device model failed.';
  if (/not available|unavailable|not supported/i.test(message)) return new Error(HARDWARE_HINT);
  return error instanceof Error ? error : new Error(message);
}
