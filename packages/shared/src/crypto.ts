export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashBody(text: string): Promise<string> {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return sha256Hex(normalized);
}
