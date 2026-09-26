import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPipeline = vi.fn();
const mockEnv: Record<string, unknown> = {
  backends: { onnx: {} },
};

vi.mock('@huggingface/transformers', () => ({
  env: mockEnv,
  pipeline: mockPipeline,
}));

vi.mock('./cache', () => ({
  cachedModelDtype: vi.fn(),
  deleteCachedModel: vi.fn().mockResolvedValue(undefined),
}));

import { cachedModelDtype, deleteCachedModel } from './cache';
import { downloadQwenModel, promptWithQwen, releaseQwen, warmQwen } from './qwen-model';

function fakeGenerator(text = 'Ready.') {
  const generator = vi.fn().mockResolvedValue([{ generated_text: text }]);
  const dispose = vi.fn().mockResolvedValue(undefined);
  (generator as unknown as { dispose: typeof dispose }).dispose = dispose;
  return Object.assign(generator, { dispose });
}

function stubGpu(features: string[] = []) {
  vi.stubGlobal('navigator', {
    gpu: { requestAdapter: vi.fn().mockResolvedValue({ features: new Set(features) }) },
  });
}

describe('qwen-model runtime configuration', () => {
  beforeEach(async () => {
    await releaseQwen();
    vi.clearAllMocks();
    mockEnv.backends = { onnx: { wasm: {} } };
    stubGpu();
    if (typeof globalThis.chrome === 'undefined') {
      (globalThis as unknown as { chrome: unknown }).chrome = {
        runtime: {
          getURL: (path: string) => `chrome-extension://dummy/${path}`,
        },
      };
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rejects if the model has not been downloaded', async () => {
    vi.mocked(cachedModelDtype).mockResolvedValue(null);
    await expect(promptWithQwen('qwen2.5-0.5b', 'system prompt', 'user prompt')).rejects.toThrow(
      'Download this model in Settings.',
    );
  });

  it('reuses the loaded model across prompts and releases it when requested', async () => {
    vi.mocked(cachedModelDtype).mockResolvedValue('q4');
    const generator = fakeGenerator('<think>thinking</think>Hello from Qwen!');
    mockPipeline.mockResolvedValue(generator);

    const result = await promptWithQwen('qwen2.5-0.5b', 'system prompt', 'user prompt');
    const nextResult = await promptWithQwen('qwen2.5-0.5b', 'system prompt', 'another prompt', { maxTokens: 20 });

    expect(result).toBe('Hello from Qwen!');
    expect(nextResult).toBe('Hello from Qwen!');
    expect(mockEnv.allowLocalModels).toBe(false);
    expect(mockEnv.allowRemoteModels).toBe(true);
    expect(mockEnv.useBrowserCache).toBe(true);
    expect(mockEnv.useWasmCache).toBe(false);
    expect((mockEnv.backends as { onnx: { wasm: { wasmPaths: unknown } } }).onnx.wasm.wasmPaths).toEqual({
      mjs: 'chrome-extension://dummy/ort/ort-wasm-simd-threaded.asyncify.mjs',
      wasm: 'chrome-extension://dummy/ort/ort-wasm-simd-threaded.asyncify.wasm',
    });

    expect(mockPipeline).toHaveBeenCalledWith(
      'text-generation',
      'onnx-community/Qwen2.5-0.5B-Instruct',
      expect.objectContaining({ dtype: 'q4', device: 'webgpu' }),
    );
    expect(generator.mock.calls[1][1]).toMatchObject({ max_new_tokens: 20, do_sample: false });

    const pipelineOptions = mockPipeline.mock.calls[0][2];
    expect(pipelineOptions.local_files_only).toBeUndefined();
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    // The cache is only consulted when a model has to be loaded.
    expect(cachedModelDtype).toHaveBeenCalledTimes(1);
    expect(generator.dispose).not.toHaveBeenCalled();
    await releaseQwen();
    expect(generator.dispose).toHaveBeenCalled();
  });

  it('downloads the smaller q4f16 build when the GPU supports shader-f16', async () => {
    stubGpu(['shader-f16']);
    vi.mocked(cachedModelDtype).mockResolvedValueOnce(null).mockResolvedValue('q4f16');
    mockPipeline.mockResolvedValue(fakeGenerator());
    await downloadQwenModel('qwen3-0.6b', vi.fn());
    expect(mockPipeline.mock.calls[0][2]).toMatchObject({ dtype: 'q4f16' });
  });

  it('keeps LFM2 on q4 even when the GPU supports shader-f16', async () => {
    stubGpu(['shader-f16']);
    vi.mocked(cachedModelDtype).mockResolvedValueOnce(null).mockResolvedValue('q4');
    mockPipeline.mockResolvedValue(fakeGenerator());
    await downloadQwenModel('lfm2-700m', vi.fn());
    expect(mockPipeline.mock.calls[0][2]).toMatchObject({ dtype: 'q4' });
  });

  it('falls back to q4 and deletes the q4f16 files when that build cannot run', async () => {
    stubGpu(['shader-f16']);
    vi.mocked(cachedModelDtype).mockResolvedValueOnce(null).mockResolvedValue('q4');
    mockPipeline.mockRejectedValueOnce(new Error('kernel not implemented')).mockResolvedValue(fakeGenerator());
    const progress = vi.fn();
    await downloadQwenModel('smollm2-360m', progress);
    expect(mockPipeline.mock.calls.map((call) => call[2].dtype)).toEqual(['q4f16', 'q4']);
    expect(deleteCachedModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'smollm2-360m' }), 'q4f16');
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('runs a generation check before reporting download complete and retains the loaded model', async () => {
    vi.mocked(cachedModelDtype).mockResolvedValue('q4');
    const generator = fakeGenerator();
    mockPipeline.mockResolvedValue(generator);
    const progress = vi.fn();

    await downloadQwenModel('qwen3-0.6b', progress);
    expect(generator).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ max_new_tokens: 12 }));
    expect(progress).toHaveBeenLastCalledWith(1);
    await promptWithQwen('qwen3-0.6b', 'Summarize.', 'A short message.');
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(generator.dispose).not.toHaveBeenCalled();
  });

  it('does not mark a cached model ready when it cannot generate usable text', async () => {
    vi.mocked(cachedModelDtype).mockResolvedValue(null);
    mockPipeline.mockResolvedValue(fakeGenerator('<think>no answer</think>'));
    const progress = vi.fn();

    await expect(downloadQwenModel('qwen2.5-0.5b', progress)).rejects.toThrow('could not generate text');
    expect(progress).not.toHaveBeenCalledWith(1);
  });

  it('reports a download whose files the browser did not keep', async () => {
    vi.mocked(cachedModelDtype).mockResolvedValue(null);
    mockPipeline.mockResolvedValue(fakeGenerator());
    await expect(downloadQwenModel('lfm2-700m', vi.fn())).rejects.toThrow('could not save the model files');
  });

  it('reloads the model after a failed generation instead of reusing a broken session', async () => {
    vi.mocked(cachedModelDtype).mockResolvedValue('q4');
    const broken = fakeGenerator();
    broken.mockRejectedValueOnce(new Error('GPU device lost'));
    mockPipeline.mockResolvedValueOnce(broken).mockResolvedValue(fakeGenerator('Back again.'));

    await expect(promptWithQwen('qwen2.5-0.5b', 's', 'u')).rejects.toThrow('GPU device lost');
    expect(broken.dispose).toHaveBeenCalled();
    await expect(promptWithQwen('qwen2.5-0.5b', 's', 'u')).resolves.toBe('Back again.');
    expect(mockPipeline).toHaveBeenCalledTimes(2);
  });

  it('runs a waiting interactive prompt before queued background sorting', async () => {
    vi.mocked(cachedModelDtype).mockResolvedValue('q4');
    const order: string[] = [];
    const generator = fakeGenerator();
    generator.mockImplementation(async (messages: Array<{ content?: string }>) => {
      order.push(messages.at(-1)?.content ?? '');
      return [{ generated_text: 'ok' }];
    });
    mockPipeline.mockResolvedValue(generator);

    const first = promptWithQwen('qwen2.5-0.5b', 's', 'sort 1', { priority: 'background' });
    const second = promptWithQwen('qwen2.5-0.5b', 's', 'sort 2', { priority: 'background' });
    const draft = promptWithQwen('qwen2.5-0.5b', 's', 'draft', { priority: 'interactive' });
    await Promise.all([first, second, draft]);
    expect(order).toEqual(['sort 1', 'draft', 'sort 2']);
  });

  it('warms a downloaded model without a prompt from the user', async () => {
    vi.mocked(cachedModelDtype).mockResolvedValue('q4');
    const generator = fakeGenerator();
    mockPipeline.mockResolvedValue(generator);
    await warmQwen('lfm2-700m');
    expect(generator).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ max_new_tokens: 1 }));
    await promptWithQwen('lfm2-700m', 's', 'u');
    expect(mockPipeline).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable WebGPU before attempting to load the model', async () => {
    vi.stubGlobal('navigator', {});
    vi.mocked(cachedModelDtype).mockResolvedValue('q4');
    await expect(promptWithQwen('qwen3-0.6b', 'Summarize.', 'A short message.')).rejects.toThrow('needs WebGPU');
    expect(mockPipeline).not.toHaveBeenCalled();
  });
});
