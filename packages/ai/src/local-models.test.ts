import { describe, expect, it } from 'vitest';
import {
  LOCAL_MODELS,
  downloadedLocalDtype,
  formatDownloadSize,
  localModelBytes,
  localModelDtypes,
  getLocalModel,
  localModelIsDownloaded,
  localModelWeightMarker,
} from './local-models.js';

describe('local model catalog', () => {
  it('lists lightweight models with ratings and tradeoffs, none downloaded yet', () => {
    expect(LOCAL_MODELS.map((model) => model.id)).toEqual([
      'lfm2-700m',
      'lfm2-1.2b',
      'gemma-3-1b',
      'qwen3-0.6b',
      'qwen2.5-0.5b',
      'smollm2-360m',
    ]);
    expect(new Set(LOCAL_MODELS.map((model) => model.repo)).size).toBe(LOCAL_MODELS.length);
    for (const model of LOCAL_MODELS) {
      expect(localModelIsDownloaded([], model)).toBe(false);
      expect(model.bytes).toBeLessThan(1024 * 1024 * 1024);
      expect(model.quality).toBeGreaterThanOrEqual(1);
      expect(model.speed).toBeLessThanOrEqual(5);
      expect(model.pros.length).toBeGreaterThan(0);
      expect(model.cons.length).toBeGreaterThan(0);
    }
  });

  it('needs the data file before a split-weight model counts as downloaded', () => {
    const model = getLocalModel('lfm2-700m')!;
    const header = `https://huggingface.co/${localModelWeightMarker(model)}`;
    expect(localModelIsDownloaded([header], model)).toBe(false);
    expect(localModelIsDownloaded([header, `${header}_data`], model)).toBe(true);
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

  it('prefers a cached q4f16 build and falls back to q4', () => {
    const model = getLocalModel('qwen3-0.6b')!;
    const q4 = `https://huggingface.co/${localModelWeightMarker(model, 'q4')}`;
    const f16 = `https://huggingface.co/${localModelWeightMarker(model, 'q4f16')}`;
    expect(downloadedLocalDtype([q4], model)).toBe('q4');
    expect(downloadedLocalDtype([q4, f16], model)).toBe('q4f16');
    expect(localModelDtypes(model, true)).toEqual(['q4f16', 'q4']);
    expect(localModelDtypes(model, false)).toEqual(['q4']);
    expect(localModelDtypes(getLocalModel('gemma-3-1b')!, true)).toEqual(['q4']);
    expect(localModelDtypes(getLocalModel('qwen2.5-0.5b')!, true)).toEqual(['q4']);
    expect(localModelBytes(model, 'q4f16')).toBeLessThan(localModelBytes(model, 'q4'));
  });

  it('formats the download size in megabytes', () => {
    expect(formatDownloadSize(786_156_820)).toBe('750 MB');
  });
});
