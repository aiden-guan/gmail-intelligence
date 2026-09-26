/** RFC 7636 PKCE helpers. Web Crypto only, so they run in extensions, browsers and Workers. */

export type PkcePair = { verifier: string; challenge: string };

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomUrlToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function createPkcePair(): Promise<PkcePair> {
  // 48 random bytes → 64 base64url chars (RFC 7636 allows 43–128).
  const verifier = randomUrlToken(48);
  return { verifier, challenge: await pkceChallenge(verifier) };
}
