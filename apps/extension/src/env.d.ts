/// <reference types="vite/client" />

/**
 * Build-time configuration. Everything here is public and ends up in the shipped
 * JavaScript, so it must never hold a secret. See docs/cloud-protocol.md.
 */
interface ImportMetaEnv {
  /** PigeonBox Cloud API origin for this build. Blank: Cloud is unavailable and Local is the only mode. */
  readonly VITE_PIGEONBOX_CLOUD_API_URL?: string;
  /** Hosted tracker origin used in Cloud mode. */
  readonly VITE_PIGEONBOX_CLOUD_TRACKER_URL?: string;
  /** "false" hides experimental features (ChatGPT web sign-in). Release builds set it. */
  readonly VITE_PIGEONBOX_EXPERIMENTAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
