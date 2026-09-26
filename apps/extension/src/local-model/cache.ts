import {
  LOCAL_MODELS,
  downloadedLocalDtype,
  localModelIsDownloaded,
  localModelWeightMarker,
  type LocalDtype,
  type LocalModel,
} from '@gi/ai';
import { deleteStoredModelUrls, storedModelUrls } from './model-store';

export async function listDownloadedModelIds(): Promise<string[]> {
  const urls = await cachedUrls();
  return LOCAL_MODELS.filter((model) => localModelIsDownloaded(urls, model)).map((model) => model.id);
}

/** The weight build of this model already stored, if any. */
export async function cachedModelDtype(model: LocalModel): Promise<LocalDtype | null> {
  return downloadedLocalDtype(await cachedUrls(), model);
}

export async function deleteCachedModel(model: LocalModel, dtype?: LocalDtype): Promise<void> {
  // With a dtype, drop only that weight build and keep the shared tokenizer and config.
  const marker = dtype ? localModelWeightMarker(model, dtype) : `/${model.repo}/`;
  await deleteStoredModelUrls((url) => url.includes(marker));
}

async function cachedUrls(): Promise<string[]> {
  try {
    return await storedModelUrls();
  } catch {
    return [];
  }
}
