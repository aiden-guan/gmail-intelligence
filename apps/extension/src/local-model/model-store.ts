import { localModelCacheName } from '@gi/ai';

/**
 * Model files live in the origin private file system. The Cache API that
 * transformers.js uses by default fails on single entries of a few hundred MB
 * in some Chrome builds ("Unexpected internal error"), and transformers.js
 * swallows that error: the model then re-downloads on every load and never
 * shows as downloaded. OPFS writes stream to disk with no entry size limit.
 *
 * Files saved to the Cache API by earlier versions are still read, so nobody
 * has to download a working model again.
 */
const DIR = 'model-files';

export type ModelFileStore = {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
};

async function directory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR, { create });
  } catch {
    return null;
  }
}

const fileName = (url: string) => encodeURIComponent(url);

async function legacyCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(localModelCacheName());
  } catch {
    return null;
  }
}

export const modelFileStore: ModelFileStore = {
  async match(url) {
    // transformers.js also probes local paths such as "/models/...". Only remote files are stored.
    if (!/^https?:\/\//.test(url)) return undefined;
    const dir = await directory(false);
    if (dir) {
      try {
        const file = await (await dir.getFileHandle(fileName(url))).getFile();
        return new Response(file, { status: 200, headers: { 'content-length': String(file.size) } });
      } catch {
        /* Not in OPFS. */
      }
    }
    return (await (await legacyCache())?.match(url)) ?? undefined;
  },

  async put(url, response) {
    if (!/^https?:\/\//.test(url)) return;
    const dir = await directory(true);
    if (!dir) throw new Error('This browser cannot store model files.');
    const handle = await dir.getFileHandle(fileName(url), { create: true });
    const writable = await handle.createWritable();
    try {
      // The write lands in a swap file and replaces the real one only on close, so a crash leaves no partial model.
      if (response.body) {
        await response.body.pipeTo(writable);
      } else {
        await writable.write(await response.arrayBuffer());
        await writable.close();
      }
    } catch (error) {
      await writable.abort().catch(() => undefined);
      await dir.removeEntry(fileName(url)).catch(() => undefined);
      throw error;
    }
  },

  async delete(url) {
    const dir = await directory(false);
    const removed = dir ? await dir.removeEntry(fileName(url)).then(() => true, () => false) : false;
    const legacy = (await (await legacyCache())?.delete(url)) ?? false;
    return removed || legacy;
  },
};

/** Every stored model file URL, from OPFS and the legacy Cache API. */
export async function storedModelUrls(): Promise<string[]> {
  const urls = new Set<string>();
  const dir = await directory(false);
  if (dir) {
    for await (const name of (dir as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) {
      try {
        urls.add(decodeURIComponent(name));
      } catch {
        /* A foreign file name. */
      }
    }
  }
  const legacy = await legacyCache();
  if (legacy) {
    try {
      for (const request of await legacy.keys()) urls.add(request.url);
    } catch {
      /* Cache unreadable. */
    }
  }
  return [...urls];
}

export async function deleteStoredModelUrls(matches: (url: string) => boolean): Promise<void> {
  const targets = (await storedModelUrls()).filter(matches);
  await Promise.all(targets.map((url) => modelFileStore.delete(url)));
}
