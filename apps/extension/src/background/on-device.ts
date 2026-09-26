import type { PromptOptions } from '@gi/ai';

const OFFSCREEN_URL = 'offscreen.html';

export async function completeOnDevice(
  modelId: string,
  system: string,
  user: string,
  options?: PromptOptions,
): Promise<{ text: string }> {
  await ensureOnDeviceDocument();
  return readText(
    await chrome.runtime.sendMessage({
      type: 'ON_DEVICE_PROMPT',
      modelId,
      system,
      user,
      examples: options?.examples,
      repetitionPenalty: options?.repetitionPenalty,
    }),
  );
}

export async function downloadOnDevice(modelId: string): Promise<void> {
  await ensureOnDeviceDocument();
  const response = (await chrome.runtime.sendMessage({
    type: 'ON_DEVICE_DOWNLOAD',
    modelId,
  })) as { ok?: boolean; error?: string } | undefined;
  if (response?.error) throw new Error(response.error);
  if (!response?.ok) throw new Error('Could not download the model.');
}

async function readText(response: unknown): Promise<{ text: string }> {
  const body = response as { text?: string; error?: string } | undefined;
  if (body?.error) throw new Error(body.error);
  if (!body?.text) throw new Error('On-device model returned an empty response.');
  return { text: body.text };
}

async function ensureOnDeviceDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Run a downloaded language model for inbox summaries and drafts.',
    });
  }

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      const response = (await chrome.runtime.sendMessage({ type: 'ON_DEVICE_PING' })) as
        | { ok?: boolean }
        | undefined;
      if (response?.ok) return;
    } catch {
      /* The document is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The on-device model did not start. Reload the extension and try again.');
}
