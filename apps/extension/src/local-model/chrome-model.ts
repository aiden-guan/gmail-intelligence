import type { ChatExample, PromptOptions } from '@gi/ai';
import { createScheduler } from './scheduler';

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
  /** Copies the session with its processed initial prompts. Missing on older Chrome builds. */
  clone?: () => Promise<ModelSession>;
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

const schedule = createScheduler();
/** Sessions already primed with a system prompt and examples, keyed by those prompts. */
const primed = new Map<string, ModelSession>();
const MAX_PRIMED = 3;

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

export function promptWithChromeModel(system: string, user: string, options?: PromptOptions): Promise<string> {
  return schedule(options?.priority ?? 'interactive', () => runPrompt(system, user, options?.examples));
}

export function onDeviceUnavailableMessage(status: OnDeviceAvailability): string {
  if (status === 'unsupported' || status === 'unavailable') return HARDWARE_HINT;
  return '';
}

async function runPrompt(system: string, user: string, examples: ChatExample[] = []): Promise<string> {
  const model = getLanguageModel();
  if (!model) throw new Error(HARDWARE_HINT);
  const initialPrompts: NonNullable<ChromeModelOptions['initialPrompts']> = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...examples.flatMap((example) => [
      { role: 'user' as const, content: example.user },
      { role: 'assistant' as const, content: example.assistant },
    ]),
  ];
  const key = JSON.stringify(initialPrompts);
  let session: ModelSession;
  try {
    session = await freshSession(model, key, initialPrompts);
  } catch (error) {
    throw normalizeModelError(error);
  }
  try {
    const text = await session.prompt(user.slice(0, 8000));
    if (!text.trim()) throw new Error('On-device model returned an empty response.');
    return text;
  } catch (error) {
    dropPrimed(key);
    throw normalizeModelError(error);
  } finally {
    session.destroy();
  }
}

/**
 * Cloning a primed session skips re-reading the system prompt and examples,
 * which is most of the input for a short email.
 */
async function freshSession(
  model: ModelFactory,
  key: string,
  initialPrompts: NonNullable<ChromeModelOptions['initialPrompts']>,
): Promise<ModelSession> {
  const base = primed.get(key);
  if (base?.clone) {
    try {
      return await base.clone();
    } catch {
      dropPrimed(key);
    }
  }
  const availability = await model.availability(chromeModelOptions);
  if (availability !== 'available') {
    throw new Error('Download the on-device model in Settings.');
  }
  const created = await model.create({
    ...chromeModelOptions,
    initialPrompts: initialPrompts.length ? initialPrompts : undefined,
  });
  if (!created.clone) return created;
  if (primed.size >= MAX_PRIMED) dropPrimed(primed.keys().next().value!);
  primed.set(key, created);
  return created.clone();
}

function dropPrimed(key: string): void {
  primed.get(key)?.destroy();
  primed.delete(key);
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
