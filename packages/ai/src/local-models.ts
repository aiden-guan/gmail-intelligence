/**
 * Lightweight on-device models. Weights are not shipped with the extension.
 * A model is on disk only after the user downloads it into the browser cache.
 */

export type LocalDtype = 'q4' | 'q4f16';

export type LocalModelVendor = 'qwen' | 'liquid' | 'google' | 'huggingface';

export type LocalModel = {
  id: string;
  label: string;
  vendor: LocalModelVendor;
  repo: string;
  blurb: string;
  /** Portable weight build. Runs on any WebGPU adapter. */
  dtype: LocalDtype;
  /** Size of the weight files, the bulk of the download. */
  bytes: number;
  /**
   * Smaller, faster q4f16 build for GPUs with shader-f16. Only set where it
   * was verified to match q4 output: Gemma and LFM2 model cards recommend q4.
   */
  f16Bytes?: number;
  /** Weights are split into model_<dtype>.onnx plus a model_<dtype>.onnx_data file. */
  externalData?: boolean;
  /** Short tag shown beside the name. */
  badge?: string;
  /** Rough 1–5 ratings for drafting quality and generation speed on a laptop GPU. */
  quality: number;
  speed: number;
  languages: 'English' | 'Multilingual';
  pros: string[];
  cons: string[];
};

/**
 * Every model here is a q4 ONNX build under ~900 MB that runs through WebGPU in
 * the offscreen document. Larger 1.5B+ builds (Qwen2.5 1.5B, Llama 3.2 1B q4)
 * are left out: their 1.6 GB+ downloads and memory use make Gmail stutter.
 */
export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    id: 'lfm2-700m',
    label: 'Liquid LFM2 700M',
    vendor: 'liquid',
    repo: 'onnx-community/LFM2-700M-ONNX',
    blurb: 'Built for on-device use. The best balance of reply quality and speed.',
    dtype: 'q4',
    bytes: 559_265_097,
    externalData: true,
    badge: 'Recommended',
    quality: 3.5,
    speed: 4.5,
    languages: 'Multilingual',
    pros: ['Fast for its size', 'Follows reply instructions well', 'Small download'],
    cons: ['Can miss details in long threads'],
  },
  {
    id: 'lfm2-1.2b',
    label: 'Liquid LFM2 1.2B',
    vendor: 'liquid',
    repo: 'onnx-community/LFM2-1.2B-ONNX',
    blurb: 'The strongest writer here. Better on long threads and tricky requests.',
    dtype: 'q4',
    bytes: 850_242_940,
    externalData: true,
    badge: 'Best quality',
    quality: 4.5,
    speed: 3.5,
    languages: 'Multilingual',
    pros: ['Most accurate drafts and summaries', 'Handles multi-message threads'],
    cons: ['About twice as slow as the 700M', 'Uses more GPU memory'],
  },
  {
    id: 'gemma-3-1b',
    label: 'Google Gemma 3 1B',
    vendor: 'google',
    repo: 'onnx-community/gemma-3-1b-it-ONNX',
    blurb: 'Warm, natural-sounding replies from Google’s smallest Gemma.',
    dtype: 'q4',
    bytes: 859_454_179,
    externalData: true,
    quality: 4,
    speed: 3,
    languages: 'Multilingual',
    pros: ['Most natural tone', 'Good at polite, short replies'],
    cons: ['Slowest model here', 'Weaker at strict JSON, so sorting is less reliable'],
  },
  {
    id: 'qwen3-0.6b',
    label: 'Qwen3 0.6B',
    vendor: 'qwen',
    repo: 'onnx-community/Qwen3-0.6B-ONNX',
    blurb: 'A newer Qwen with a bit more skill, still under 1 GB.',
    dtype: 'q4',
    bytes: 919_096_585,
    f16Bytes: 569_789_750,
    quality: 3,
    speed: 4,
    languages: 'Multilingual',
    pros: ['Reliable for sorting and summaries', 'Strong in many languages'],
    cons: ['Largest download of the small models', 'Drafts can sound stiff'],
  },
  {
    id: 'qwen2.5-0.5b',
    label: 'Qwen2.5 0.5B',
    vendor: 'qwen',
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    blurb: 'Lightest Qwen. Fast enough for sorting mail and short drafts.',
    dtype: 'q4',
    // Its q4f16 build loops and emits nonsense on WebGPU, so it stays on q4.
    bytes: 786_156_820,
    quality: 2.5,
    speed: 4.5,
    languages: 'Multilingual',
    pros: ['Quick and dependable for sorting', 'Low memory use'],
    cons: ['Short, generic drafts', 'Sometimes summarizes instead of replying'],
  },
  {
    id: 'smollm2-360m',
    label: 'SmolLM2 360M',
    vendor: 'huggingface',
    repo: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    blurb: 'Tiny and instant. Best for older laptops or sorting mail only.',
    dtype: 'q4',
    bytes: 387_943_246,
    f16Bytes: 272_737_275,
    badge: 'Fastest',
    quality: 2,
    speed: 5,
    languages: 'English',
    pros: ['Smallest download', 'Fastest responses', 'Easy on battery'],
    cons: ['Weak drafts', 'English only'],
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

/** Weight builds to use, best first. */
export function localModelDtypes(model: LocalModel, shaderF16: boolean): LocalDtype[] {
  return shaderF16 && model.f16Bytes ? ['q4f16', model.dtype] : [model.dtype];
}

export function localModelBytes(model: LocalModel, dtype: LocalDtype): number {
  return dtype === 'q4f16' && model.f16Bytes ? model.f16Bytes : model.bytes;
}

export function localModelWeightMarker(model: LocalModel, dtype: LocalDtype = model.dtype): string {
  return `${model.repo}/resolve/main/onnx/model_${dtype}.onnx`;
}

/** The weight build already in the cache, preferring q4f16. */
export function downloadedLocalDtype(cachedUrls: readonly string[], model: LocalModel): LocalDtype | null {
  for (const dtype of localModelDtypes(model, true)) {
    const marker = localModelWeightMarker(model, dtype);
    const hasFile = (suffix: string) => cachedUrls.some((url) => url.endsWith(`${marker}${suffix}`) || url.includes(`${marker}${suffix}?`));
    // The small .onnx header is useless without its data file.
    if (hasFile('') && (!model.externalData || hasFile('_data'))) return dtype;
  }
  return null;
}

export function localModelIsDownloaded(cachedUrls: readonly string[], model: LocalModel): boolean {
  return downloadedLocalDtype(cachedUrls, model) !== null;
}

export function formatDownloadSize(bytes: number): string {
  const mb = Math.round(bytes / (1024 * 1024));
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export function localModelCacheName(): string {
  return CACHE_NAME;
}
