import type { TrackedEmailSummary } from '@gi/tracking';

const KEY = 'trackedEmails';
const MAX_TRACKED = 400;

export async function readTrackedEmails(): Promise<TrackedEmailSummary[]> {
  const stored = await chrome.storage.local.get(KEY);
  const value = stored[KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(isSummary);
}

export async function writeTrackedEmails(emails: TrackedEmailSummary[]): Promise<void> {
  const capped = [...emails]
    .sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0))
    .slice(0, MAX_TRACKED);
  await chrome.storage.local.set({ [KEY]: capped });
}

export async function upsertTrackedEmail(email: TrackedEmailSummary): Promise<TrackedEmailSummary[]> {
  const current = await readTrackedEmails();
  const next = current.filter((item) => item.trackingId !== email.trackingId);
  next.push(email);
  await writeTrackedEmails(next);
  return readTrackedEmails();
}

export async function patchTrackedEmail(
  trackingId: string,
  patch: Partial<TrackedEmailSummary>,
): Promise<TrackedEmailSummary | null> {
  const current = await readTrackedEmails();
  const index = current.findIndex((item) => item.trackingId === trackingId);
  if (index < 0) return null;
  current[index] = { ...current[index], ...patch, trackingId };
  await writeTrackedEmails(current);
  return current[index];
}

function isSummary(value: unknown): value is TrackedEmailSummary {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<TrackedEmailSummary>;
  return typeof row.trackingId === 'string' && typeof row.sentAt === 'string' && Array.isArray(row.recipients);
}
