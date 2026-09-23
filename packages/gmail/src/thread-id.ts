/** Views that may expose a Gmail thread id synchronously or as a promise. */
export type ThreadIdView = {
  getThreadID?: () => string | null | undefined | Promise<string | null | undefined>;
  getThreadIDAsync?: () => string | Promise<string | null | undefined>;
};

function asPromise<T>(value: T | Promise<T>): Promise<T> {
  return Promise.resolve(value);
}

/**
 * One resolver for row, thread, and compose views.
 * A Promise from getThreadID/getThreadIDAsync is awaited. Non-strings are dropped.
 */
export async function resolveThreadId(view: ThreadIdView | null | undefined): Promise<string | null> {
  if (!view) return null;
  try {
    if (typeof view.getThreadID === 'function') {
      const sync = await asPromise(view.getThreadID());
      if (typeof sync === 'string' && sync.trim()) return sync.trim();
    }
  } catch {
    /* try the async method */
  }
  try {
    if (typeof view.getThreadIDAsync === 'function') {
      const asyncId = await asPromise(view.getThreadIDAsync());
      if (typeof asyncId === 'string' && asyncId.trim()) return asyncId.trim();
    }
  } catch {
    return null;
  }
  return null;
}
