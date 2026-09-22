import { describe, expect, it } from 'vitest';
import {
  LOCAL_MODELS,
  formatDownloadSize,
  getLocalModel,
  localModelIsDownloaded,
  localModelWeightMarker,
} from './local-models.js';

describe('local model catalog', () => {
  it('lists lightweight Qwen models without treating them as downloaded', () => {
    expect(LOCAL_MODELS.map((model) => model.id)).toEqual(['qwen2.5-0.5b', 'qwen3-0.6b']);
    for (const model of LOCAL_MODELS) {
      expect(localModelIsDownloaded([], model)).toBe(false);
      expect(model.bytes).toBeLessThan(1024 * 1024 * 1024);
    }
  });

  it('counts a model as downloaded only when its weight file is cached', () => {
    const light = getLocalModel('qwen2.5-0.5b');
    const stronger = getLocalModel('qwen3-0.6b');
    expect(light).not.toBeNull();
    expect(stronger).not.toBeNull();
    const cached = [`https://huggingface.co/${localModelWeightMarker(light!)}`];
    expect(localModelIsDownloaded(cached, light!)).toBe(true);
    expect(localModelIsDownloaded(cached, stronger!)).toBe(false);
  });

  it('formats the download size in megabytes', () => {
    expect(formatDownloadSize(786_156_820)).toBe('750 MB');
  });
});
