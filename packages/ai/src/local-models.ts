/**
 * Lightweight on-device models. Weights are not shipped with the extension.
 * A model is on disk only after the user downloads it into the browser cache.
 */

export type LocalDtype = 'q4';

export type LocalModel = {
  id: string;
  label: string;
  repo: string;
  blurb: string;
  dtype: LocalDtype;
  bytes: number;
};

export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    id: 'qwen2.5-0.5b',
    label: 'Qwen2.5 0.5B',
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    blurb: 'Lightest Qwen. Fast enough for sorting mail and short drafts.',
    dtype: 'q4',
    bytes: 786_156_820,
  },
  {
    id: 'qwen3-0.6b',
    label: 'Qwen3 0.6B',
    repo: 'onnx-community/Qwen3-0.6B-ONNX',
    blurb: 'A newer Qwen with a bit more skill, still under 1 GB.',
    dtype: 'q4',
    bytes: 919_096_585,
  },
];

export const LOCAL_MODEL_ORIGINS = [
  'https://huggingface.co/*',
  'https://cdn-lfs.huggingface.co/*',
  'https://cas-bridge.xethub.hf.co/*',
  'https://*.hf.co/*',
] as const;

const CACHE_NAME = 'transformers-cache';

export function getLocalModel(id: string): LocalModel | null {
  return LOCAL_MODELS.find((model) => model.id === id) ?? null;
}

export function localModelWeightMarker(model: LocalModel): string {
  return `${model.repo}/resolve/main/onnx/model_${model.dtype}.onnx`;
}

export function localModelIsDownloaded(cachedUrls: readonly string[], model: LocalModel): boolean {
  const marker = localModelWeightMarker(model);
  return cachedUrls.some((url) => url.includes(marker));
}

export function formatDownloadSize(bytes: number): string {
  const mb = Math.round(bytes / (1024 * 1024));
  return `${mb} MB`;
}

export function localModelCacheName(): string {
  return CACHE_NAME;
}
