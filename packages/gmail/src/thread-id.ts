/** Views that may expose a Gmail thread id synchronously or as a promise. */
export type ThreadIdView = {
  getThreadID?: () => string | null | undefined | Promise<string | null | undefined>;
  getThreadIDAsync?: () => string | Promise<string | null | undefined>;
};

/** Views that may expose a Gmail message id synchronously or as a promise. */
export type MessageIdView = {
  isLoaded?: () => boolean;
  getMessageID?: () => string | null | undefined | Promise<string | null | undefined>;
  getMessageIDAsync?: () => string | Promise<string | null | undefined>;
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
  // InboxSDK warns if getThreadID is touched. Use the async method whenever it exists.
  if (typeof view.getThreadIDAsync === 'function') {
    try {
      const asyncId = await asPromise(view.getThreadIDAsync());
      if (typeof asyncId === 'string' && asyncId.trim()) return asyncId.trim();
    } catch {
      return null;
    }
  }
  try {
    if (typeof view.getThreadID === 'function') {
      const sync = await asPromise(view.getThreadID());
      if (typeof sync === 'string' && sync.trim()) return sync.trim();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolves a message ID from an InboxSDK MessageView.
 * If the message view is not loaded, returns null without touching getMessageID
 * (which throws 'tried to get message id before message is loaded').
 * Uses getMessageIDAsync when available to avoid deprecation warnings.
 */
export async function resolveMessageId(view: MessageIdView | null | undefined): Promise<string | null> {
  if (!view) return null;
  // Guard against calling getMessageID/getMessageIDAsync on collapsed or unloaded views
  if (typeof view.isLoaded === 'function' && !view.isLoaded()) {
    return null;
  }
  if (typeof view.getMessageIDAsync === 'function') {
    try {
      const asyncId = await asPromise(view.getMessageIDAsync());
      if (typeof asyncId === 'string' && asyncId.trim()) return asyncId.trim();
    } catch {
      return null;
    }
  }
  try {
    if (typeof view.getMessageID === 'function') {
      const sync = await asPromise(view.getMessageID());
      if (typeof sync === 'string' && sync.trim()) return sync.trim();
    }
  } catch {
    return null;
  }
  return null;
}

