import {
  LOCAL_MODELS,
  localModelCacheName,
  localModelIsDownloaded,
  type LocalModel,
} from '@gi/ai';

export async function listDownloadedModelIds(): Promise<string[]> {
  const urls = await cachedUrls();
  return LOCAL_MODELS.filter((model) => localModelIsDownloaded(urls, model)).map((model) => model.id);
}

export async function deleteCachedModel(model: LocalModel): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(localModelCacheName());
  const keys = await cache.keys();
  await Promise.all(
    keys.filter((request) => request.url.includes(model.repo)).map((request) => cache.delete(request)),
  );
}

async function cachedUrls(): Promise<string[]> {
  if (typeof caches === 'undefined') return [];
  try {
    const cache = await caches.open(localModelCacheName());
    const keys = await cache.keys();
    return keys.map((request) => request.url);
  } catch {
    return [];
  }
}
