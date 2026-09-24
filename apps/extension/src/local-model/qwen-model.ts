import { getLocalModel, type LocalModel } from '@gi/ai';
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
      tokenizer_encode_kwargs?: { enable_thinking: boolean };
    },
  ): Promise<Array<{ generated_text?: string | ChatTurn[] }>>;
  dispose: () => Promise<void>;
};

let configured = false;
let promptChain: Promise<void> = Promise.resolve();

export function downloadQwenModel(modelId: string, onProgress: (fraction: number) => void): Promise<void> {
  return runExclusive(() => downloadModel(modelId, onProgress));
}

export function promptWithQwen(modelId: string, system: string, user: string): Promise<string> {
  return runExclusive(() => generate(modelId, system, user));
}

export function releaseQwen(): void {
  configured = false;
}

async function downloadModel(modelId: string, onProgress: (fraction: number) => void): Promise<void> {
  const model = requireModel(modelId);
  await configureRuntime();
  const { pipeline } = await import('@huggingface/transformers');
  const generator = (await pipeline('text-generation', model.repo, {
    dtype: model.dtype,
    device: 'wasm',
    progress_callback: (info: ProgressInfo) => {
      if (!info.file?.includes(`model_${model.dtype}.onnx`)) return;
      if (info.status === 'progress' && info.total) {
        onProgress(clamp((info.loaded ?? 0) / info.total));
      }
      if (info.status === 'done') onProgress(1);
    },
  })) as Generator;
  await generator.dispose();
  onProgress(1);
}

async function generate(modelId: string, system: string, user: string): Promise<string> {
  const model = requireModel(modelId);
  const downloaded = await listDownloadedModelIds();
  if (!downloaded.includes(model.id)) throw new Error('Download this model in Settings.');
  await configureRuntime();
  const { pipeline } = await import('@huggingface/transformers');
  const generator = (await pipeline('text-generation', model.repo, {
    dtype: model.dtype,
    device: 'wasm',
  })) as Generator;
  try {
    const output = await generator(chatMessages(model, system, user), {
      max_new_tokens: 512,
      do_sample: false,
      tokenizer_encode_kwargs: model.id === 'qwen3-0.6b' ? { enable_thinking: false } : undefined,
    });
    const text = stripThinking(textFromGeneration(output));
    if (!text) throw new Error('On-device model returned an empty response.');
    return text;
  } finally {
    await generator.dispose();
  }
}

function chatMessages(model: LocalModel, system: string, user: string): ChatTurn[] {
  const prompt = model.id === 'qwen3-0.6b' ? `${user}\n/no_think` : user;
  return [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];
}

async function configureRuntime(): Promise<void> {
  const { env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.useWasmCache = false;
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
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
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
