import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chromeModelOptions,
  getOnDeviceAvailability,
  promptWithChromeModel,
  startOnDeviceDownload,
} from './chrome-model';

type FakeModel = {
  availability: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

function installModel(session?: { prompt: (input: string) => Promise<string>; destroy: () => void }): FakeModel {
  const model: FakeModel = {
    availability: vi.fn(async () => 'available'),
    create: vi.fn(async () => session ?? { prompt: async () => 'hello', destroy() {} }),
  };
  Object.assign(globalThis, { LanguageModel: model });
  return model;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'LanguageModel');
});

describe('chrome model language', () => {
  it('requests English text for availability, download, and prompts', async () => {
    const model = installModel();

    await expect(getOnDeviceAvailability()).resolves.toBe('available');
    await startOnDeviceDownload(() => undefined);
    await expect(promptWithChromeModel('Be brief.', 'Hi')).resolves.toBe('hello');

    expect(model.availability).toHaveBeenCalledWith(chromeModelOptions);
    expect(chromeModelOptions.expectedOutputs).toEqual([{ type: 'text', languages: ['en'] }]);
    for (const call of model.create.mock.calls) {
      expect(call[0]).toMatchObject(chromeModelOptions);
    }
  });
});
