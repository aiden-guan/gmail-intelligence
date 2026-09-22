import { downloadQwenModel, promptWithQwen, releaseQwen } from '../local-model/qwen-model';
import { promptWithChromeModel } from '../local-model/chrome-model';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ON_DEVICE_PING') {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'LOCAL_MODEL_RELEASE') {
    releaseQwen();
    return false;
  }
  if (message?.type === 'ON_DEVICE_DOWNLOAD') {
    void downloadQwenModel(String(message.modelId || ''), (fraction) => {
      chrome.runtime
        .sendMessage({ type: 'LOCAL_MODEL_PROGRESS', modelId: message.modelId, fraction })
        .catch(() => undefined);
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => {
        sendResponse({ error: error instanceof Error ? error.message : 'Could not download the model.' });
      });
    return true;
  }
  if (message?.type !== 'ON_DEVICE_PROMPT') return false;
  const modelId = String(message.modelId || 'gemini-nano');
  const pending =
    modelId === 'gemini-nano'
      ? promptWithChromeModel(String(message.system || ''), String(message.user || ''))
      : promptWithQwen(modelId, String(message.system || ''), String(message.user || ''));
  void pending
    .then((text) => sendResponse({ text }))
    .catch((error: unknown) => {
      sendResponse({
        error: error instanceof Error ? error.message : 'On-device model failed.',
      });
    });
  return true;
});
