import { getLocalModel, type ChatExample, type LocalModel, type PromptOptions } from '@gi/ai';
import { listDownloadedModelIds } from './cache';

type ProgressInfo = {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
};

type ChatTurn = { role: string; content?: string };

type Generator = {
  (
    messages: ChatTurn[],
    options: {
      max_new_tokens: number;
      do_sample: boolean;
      repetition_penalty?: number;
      tokenizer_encode_kwargs?: { enable_thinking: boolean };
    },
  ): Promise<Array<{ generated_text?: string | ChatTurn[] }>>;
  dispose: () => Promise<void>;
};

let configured = false;
let promptChain: Promise<void> = Promise.resolve();
let activeGenerator: Generator | null = null;
let activeModelId: string | null = null;

export function downloadQwenModel(modelId: string, onProgress: (fraction: number) => void): Promise<void> {
  return runExclusive(() => downloadModel(modelId, onProgress));
}

export function promptWithQwen(modelId: string, system: string, user: string, options?: PromptOptions): Promise<string> {
  return runExclusive(() => generate(modelId, system, user, options));
}

export function releaseQwen(): Promise<void> {
  return runExclusive(async () => {
    await activeGenerator?.dispose();
    activeGenerator = null;
    activeModelId = null;
  });
}

async function downloadModel(modelId: string, onProgress: (fraction: number) => void): Promise<void> {
  const model = requireModel(modelId);
  // Some models split weights into model_q4.onnx and model_q4.onnx_data; track both against the catalog size.
  const loadedByFile = new Map<string, number>();
  const generator = await loadedGenerator(model, (info: ProgressInfo) => {
      if (!info.file?.includes(`model_${model.dtype}.onnx`)) return;
      if (info.status === 'progress' && info.total) {
        loadedByFile.set(info.file, info.loaded ?? 0);
        const loaded = [...loadedByFile.values()].reduce((sum, value) => sum + value, 0);
        onProgress(clamp(loaded / model.bytes) * 0.95);
      }
    });
  onProgress(0.95);
  // A cached weight file alone does not establish that ONNX can load and run it.
  try {
    const check = await generator(chatMessages(model, 'Answer briefly.', 'Say ready.'), {
      max_new_tokens: 12,
      do_sample: false,
      tokenizer_encode_kwargs: model.id === 'qwen3-0.6b' ? { enable_thinking: false } : undefined,
    });
    if (!stripThinking(textFromGeneration(check))) {
      throw new Error('The downloaded model could not generate text. Try removing and downloading it again.');
    }
  } catch (error) {
    await generator.dispose();
    activeGenerator = null;
    activeModelId = null;
    throw error;
  }
  onProgress(1);
}

async function generate(modelId: string, system: string, user: string, options?: PromptOptions): Promise<string> {
  const model = requireModel(modelId);
  const downloaded = await listDownloadedModelIds();
  if (!downloaded.includes(model.id)) throw new Error('Download this model in Settings.');
  const generator = await loadedGenerator(model);
  const output = await generator(chatMessages(model, system, user, options?.examples), {
    max_new_tokens: system.startsWith('You summarize') ? 128 : system.startsWith('You classify') ? 96 : 192,
    do_sample: false,
    ...(options?.repetitionPenalty ? { repetition_penalty: options.repetitionPenalty } : {}),
    tokenizer_encode_kwargs: model.id === 'qwen3-0.6b' ? { enable_thinking: false } : undefined,
  });
  const text = stripThinking(textFromGeneration(output));
  if (!text) throw new Error('On-device model returned an empty response.');
  return text;
}

async function loadedGenerator(model: LocalModel, onProgress?: (info: ProgressInfo) => void): Promise<Generator> {
  if (activeGenerator && activeModelId === model.id) return activeGenerator;
  await activeGenerator?.dispose();
  activeGenerator = null;
  activeModelId = null;
  const gpu = typeof navigator !== 'undefined'
    ? (navigator as Navigator & {
        gpu?: { requestAdapter(options?: { powerPreference?: 'low-power' }): Promise<unknown | null> };
      }).gpu
    : undefined;
  const adapter = await gpu?.requestAdapter({ powerPreference: 'low-power' });
  if (!adapter) {
    throw new Error('This local model needs WebGPU. Enable WebGPU in Chrome or choose another AI provider.');
  }
  await configureRuntime();
  const { pipeline } = await import('@huggingface/transformers');
  const generator = (await pipeline('text-generation', model.repo, {
    dtype: model.dtype,
    device: 'webgpu',
    progress_callback: onProgress,
  })) as Generator;
  activeGenerator = generator;
  activeModelId = model.id;
  return generator;
}

function chatMessages(model: LocalModel, system: string, user: string, examples: ChatExample[] = []): ChatTurn[] {
  const noThink = (text: string) => (model.id === 'qwen3-0.6b' ? `${text}\n/no_think` : text);
  return [
    { role: 'system', content: system },
    ...examples.flatMap((example) => [
      { role: 'user', content: noThink(example.user) },
      { role: 'assistant', content: example.assistant },
    ]),
    { role: 'user', content: noThink(user) },
  ];
}

async function configureRuntime(): Promise<void> {
  const { env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.useWasmCache = false;
  if (env.backends.onnx.webgpu) env.backends.onnx.webgpu.powerPreference = 'low-power';
  if (configured) return;
  const wasm = wasmConfig(env.backends.onnx);
  if (wasm) {
    wasm.numThreads = 1;
    wasm.proxy = false;
    wasm.wasmPaths = {
      mjs: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.asyncify.mjs'),
      wasm: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.asyncify.wasm'),
    };
  }
  configured = true;
}

function wasmConfig(onnx: unknown): { numThreads?: number; proxy?: boolean; wasmPaths?: unknown } | null {
  if (!onnx || typeof onnx !== 'object' || !('wasm' in onnx)) return null;
  const wasm = (onnx as { wasm?: unknown }).wasm;
  return wasm && typeof wasm === 'object' ? (wasm as { numThreads?: number; proxy?: boolean; wasmPaths?: unknown }) : null;
}

function textFromGeneration(output: Array<{ generated_text?: string | ChatTurn[] }>): string {
  const generated = output[0]?.generated_text;
  if (typeof generated === 'string') return generated.trim();
  if (!Array.isArray(generated)) return '';
  const last = generated[generated.length - 1];
  return typeof last?.content === 'string' ? last.content.trim() : '';
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/gi, '').trim();
}

function requireModel(modelId: string): LocalModel {
  const model = getLocalModel(modelId);
  if (!model) throw new Error('That model is not available.');
  return model;
}

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = promptChain.then(fn);
  promptChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
