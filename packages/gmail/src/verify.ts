export type VerifyResult = { verified: boolean; reason: string };

export function verifyOpenThread(actualThreadId: string | null, expectedThreadId: string): VerifyResult {
  if (actualThreadId && actualThreadId === expectedThreadId) {
    return { verified: true, reason: 'Opened thread matches' };
  }
  return { verified: false, reason: 'Opened thread does not match' };
}

/**
 * Archive is verified only by an archive-specific signal.
 * A thread view whose list does not contain the thread is not success.
 */
export function verifyArchive(input: {
  toastText: string | null;
  beforeOpenThreadId: string | null;
  afterOpenThreadId: string | null;
  expectedThreadId: string;
  inboxContainsThread: boolean | null;
}): VerifyResult {
  if (input.toastText && /archiv/i.test(input.toastText)) {
    return { verified: true, reason: 'Gmail showed an archive notice' };
  }
  const leftThread =
    input.beforeOpenThreadId === input.expectedThreadId &&
    input.afterOpenThreadId !== input.expectedThreadId;
  if (leftThread) {
    return { verified: true, reason: 'Gmail left the thread after archive' };
  }
  if (input.inboxContainsThread === false && input.afterOpenThreadId == null) {
    return { verified: true, reason: 'Thread is no longer in the inbox list' };
  }
  if (input.inboxContainsThread === false && input.afterOpenThreadId != null) {
    return {
      verified: false,
      reason: 'Thread view is still open. List absence is not archive confirmation',
    };
  }
  return { verified: false, reason: 'Archive was not confirmed' };
}

export function verifyDraftInserted(input: {
  composeOpen: boolean;
  bodyText: string;
  expectedText: string;
  activeThreadId: string | null;
  expectedThreadId: string;
}): VerifyResult {
  const needle = input.expectedText.trim().slice(0, 80);
  const bodyOk = needle.length > 0 && input.bodyText.includes(needle);
  const threadOk = input.activeThreadId != null && input.activeThreadId === input.expectedThreadId;
  if (input.composeOpen && bodyOk && threadOk) {
    return { verified: true, reason: 'Reply draft contains the expected text' };
  }
  if (!input.composeOpen) return { verified: false, reason: 'Reply composer did not open' };
  if (!threadOk) return { verified: false, reason: 'Reply opened on a different thread' };
  return { verified: false, reason: 'Draft text was not inserted' };
}

export function verifyInsertedText(bodyText: string, expectedText: string): VerifyResult {
  const needle = expectedText.trim().slice(0, 80);
  if (needle && bodyText.includes(needle)) {
    return { verified: true, reason: 'Compose body contains the expected text' };
  }
  return { verified: false, reason: 'Compose body does not contain the expected text' };
}

export function verifyMarkRead(beforeUnread: boolean | null, afterUnread: boolean | null): VerifyResult {
  if (beforeUnread == null || afterUnread == null) {
    return { verified: false, reason: 'Could not read the thread unread state' };
  }
  if (!afterUnread) return { verified: true, reason: beforeUnread ? 'Marked read' : 'Already read' };
  return { verified: false, reason: 'Thread is still unread' };
}

export function verifyMarkUnread(beforeUnread: boolean | null, afterUnread: boolean | null): VerifyResult {
  if (beforeUnread == null || afterUnread == null) {
    return { verified: false, reason: 'Could not read the thread unread state' };
  }
  if (afterUnread) return { verified: true, reason: beforeUnread ? 'Already unread' : 'Marked unread' };
  return { verified: false, reason: 'Thread is still read' };
}

export function verifyNavigation(actualHash: string, expectedQuery: string): VerifyResult {
  let decoded = actualHash;
  try {
    decoded = decodeURIComponent(actualHash);
  } catch {
    decoded = actualHash;
  }
  const verified = decoded.toLowerCase().includes(expectedQuery.trim().toLowerCase());
  return {
    verified,
    reason: verified ? 'Gmail route matches' : 'Gmail route does not match the requested search',
  };
}
