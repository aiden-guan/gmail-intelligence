import type { GmailCapabilities } from '@gi/shared';

export const EMPTY_CAPABILITIES: GmailCapabilities = {
  inboxSdkAvailable: false,
  gmailJsCaptureAvailable: false,
  backgroundWorkerTabAvailable: false,
  persistentNativeLabelMutationAvailable: false,
  domFallbackAvailable: true,
};

export function mergeCapabilities(
  ...parts: Partial<GmailCapabilities>[]
): GmailCapabilities {
  return {
    ...EMPTY_CAPABILITIES,
    ...Object.assign({}, ...parts),
  };
}

/** Never pretend a capability exists without detection. */
export function assertCapability(
  caps: GmailCapabilities,
  key: keyof GmailCapabilities,
): boolean {
  return Boolean(caps[key]);
}
