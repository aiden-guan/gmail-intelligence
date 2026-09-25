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
  listDownloadedModelIds: vi.fn(),
}));

import { listDownloadedModelIds } from './cache';
import { downloadQwenModel, promptWithQwen, releaseQwen } from './qwen-model';

describe('qwen-model runtime configuration', () => {
  beforeEach(async () => {
    await releaseQwen();
    vi.clearAllMocks();
    mockEnv.backends = { onnx: { wasm: {} } };
    vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn().mockResolvedValue({}) } });
    // Setup chrome runtime mock if not present
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
    vi.mocked(listDownloadedModelIds).mockResolvedValue([]);
    await expect(promptWithQwen('qwen2.5-0.5b', 'system prompt', 'user prompt')).rejects.toThrow(
      'Download this model in Settings.',
    );
  });

  it('reuses the loaded model across prompts and releases it when requested', async () => {
    vi.mocked(listDownloadedModelIds).mockResolvedValue(['qwen2.5-0.5b']);

    const mockGenerator = vi.fn().mockResolvedValue([
      { generated_text: '<think>thinking</think>Hello from Qwen!' },
    ]);
    const mockDispose = vi.fn().mockResolvedValue(undefined);
    (mockGenerator as unknown as { dispose: typeof mockDispose }).dispose = mockDispose;

    mockPipeline.mockResolvedValue(mockGenerator);

    const result = await promptWithQwen('qwen2.5-0.5b', 'system prompt', 'user prompt');
    const nextResult = await promptWithQwen('qwen2.5-0.5b', 'system prompt', 'another prompt');

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
      expect.objectContaining({
        dtype: 'q4',
        device: 'webgpu',
      }),
    );

    // Verify local_files_only is NOT true, which would trigger Transformers.js error
    const pipelineOptions = mockPipeline.mock.calls[0][2];
    expect(pipelineOptions.local_files_only).toBeUndefined();
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(mockDispose).not.toHaveBeenCalled();
    await releaseQwen();
    expect(mockDispose).toHaveBeenCalled();
  });

  it('runs a generation check before reporting download complete and retains the loaded model', async () => {
    vi.mocked(listDownloadedModelIds).mockResolvedValue(['qwen3-0.6b']);
    const generator = vi.fn().mockResolvedValue([{ generated_text: 'Ready.' }]);
    const dispose = vi.fn().mockResolvedValue(undefined);
    (generator as unknown as { dispose: typeof dispose }).dispose = dispose;
    mockPipeline.mockResolvedValue(generator);
    const progress = vi.fn();

    await downloadQwenModel('qwen3-0.6b', progress);
    expect(generator).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ max_new_tokens: 12 }),
    );
    expect(progress).toHaveBeenLastCalledWith(1);
    await promptWithQwen('qwen3-0.6b', 'Summarize.', 'A short message.');
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('does not mark a cached model ready when it cannot generate usable text', async () => {
    const generator = vi.fn().mockResolvedValue([{ generated_text: '<think>no answer</think>' }]);
    (generator as unknown as { dispose: () => Promise<void> }).dispose = vi.fn().mockResolvedValue(undefined);
    mockPipeline.mockResolvedValue(generator);
    const progress = vi.fn();

    await expect(downloadQwenModel('qwen2.5-0.5b', progress)).rejects.toThrow('could not generate text');
    expect(progress).not.toHaveBeenCalledWith(1);
  });

  it('reports unavailable WebGPU before attempting to load the model', async () => {
    vi.stubGlobal('navigator', {});
    vi.mocked(listDownloadedModelIds).mockResolvedValue(['qwen3-0.6b']);
    await expect(promptWithQwen('qwen3-0.6b', 'Summarize.', 'A short message.')).rejects.toThrow('needs WebGPU');
    expect(mockPipeline).not.toHaveBeenCalled();
  });
});
