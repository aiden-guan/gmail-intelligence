import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { promptWithQwen, releaseQwen } from './qwen-model';

describe('qwen-model runtime configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseQwen();
    mockEnv.backends = { onnx: {} };
    // Setup chrome runtime mock if not present
    if (typeof globalThis.chrome === 'undefined') {
      (globalThis as unknown as { chrome: unknown }).chrome = {
        runtime: {
          getURL: (path: string) => `chrome-extension://dummy/${path}`,
        },
      };
    }
  });

  it('rejects if the model has not been downloaded', async () => {
    vi.mocked(listDownloadedModelIds).mockResolvedValue([]);
    await expect(promptWithQwen('qwen2.5-0.5b', 'system prompt', 'user prompt')).rejects.toThrow(
      'Download this model in Settings.',
    );
  });

  it('configures transformers env with allowRemoteModels=true and does not pass local_files_only', async () => {
    vi.mocked(listDownloadedModelIds).mockResolvedValue(['qwen2.5-0.5b']);

    const mockGenerator = vi.fn().mockResolvedValue([
      { generated_text: '<think>thinking</think>Hello from Qwen!' },
    ]);
    const mockDispose = vi.fn().mockResolvedValue(undefined);
    (mockGenerator as unknown as { dispose: typeof mockDispose }).dispose = mockDispose;

    mockPipeline.mockResolvedValue(mockGenerator);

    const result = await promptWithQwen('qwen2.5-0.5b', 'system prompt', 'user prompt');

    expect(result).toBe('Hello from Qwen!');
    expect(mockEnv.allowLocalModels).toBe(false);
    expect(mockEnv.allowRemoteModels).toBe(true);
    expect(mockEnv.useBrowserCache).toBe(true);
    expect(mockEnv.useWasmCache).toBe(false);

    expect(mockPipeline).toHaveBeenCalledWith(
      'text-generation',
      'onnx-community/Qwen2.5-0.5B-Instruct',
      expect.objectContaining({
        dtype: 'q4',
        device: 'wasm',
      }),
    );

    // Verify local_files_only is NOT true, which would trigger Transformers.js error
    const pipelineOptions = mockPipeline.mock.calls[0][2];
    expect(pipelineOptions.local_files_only).toBeUndefined();
    expect(mockDispose).toHaveBeenCalled();
  });
});
