import { z } from 'zod';

/** How PigeonBox runs. Local needs no account; Cloud uses a PigeonBox account. */
export const PigeonBoxModeSchema = z.enum(['local', 'cloud']);
export type PigeonBoxMode = z.infer<typeof PigeonBoxModeSchema>;

/**
 * Product capabilities. Local capabilities are computed on the device; Cloud
 * capabilities come from the server's entitlement check. UI code asks
 * `hasCapability(...)` rather than checking a mode or a plan name.
 *
 * Only list a capability here once something implements it or a contract for it
 * exists. The server never returns capabilities it cannot serve.
 */
export const KNOWN_CAPABILITIES = [
  'local_ai',
  'cloud_ai',
  'ask_inbox',
  'cloud_search',
  'cloud_tracking',
  'cloud_sync',
  'calendar',
  'attachments',
  'background_agents',
  'memory',
  'automations',
  'mcp',
] as const;

export const PigeonBoxCapabilitySchema = z.enum(KNOWN_CAPABILITIES);
export type PigeonBoxCapability = z.infer<typeof PigeonBoxCapabilitySchema>;

/**
 * Parse a capability list from the server. Unknown names are dropped rather than
 * rejected so a newer server never breaks an older extension.
 */
export function knownCapabilities(values: readonly string[]): PigeonBoxCapability[] {
  const known = new Set<string>(KNOWN_CAPABILITIES);
  return [...new Set(values.filter((value): value is PigeonBoxCapability => known.has(value)))];
}

/** Lenient on the wire, typed after `knownCapabilities`. */
export const CapabilityListSchema = z.array(z.string().max(64)).max(64);
