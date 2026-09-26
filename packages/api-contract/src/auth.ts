import { z } from 'zod';
import { CloudUserSchema } from './account.js';

/**
 * Sign-in is Authorization Code + PKCE. The client opens
 * `GET /v1/auth/authorize` in a browser auth window (chrome.identity in the
 * extension), receives `?code=&state=` on its redirect URI, and exchanges the
 * code with its verifier. The API talks to the identity provider (Supabase Auth
 * in production); the extension never holds a Supabase key.
 */
export const AuthorizeQuerySchema = z.object({
  redirect_uri: z.string().url().max(500),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().min(16).max(200),
});
export type AuthorizeQuery = z.infer<typeof AuthorizeQuerySchema>;

export const TokenExchangeRequestSchema = z.object({
  code: z.string().min(8).max(512),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  redirectUri: z.string().url().max(500),
});

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(8).max(2_048),
});

export const SignOutRequestSchema = z.object({
  refreshToken: z.string().min(8).max(2_048).optional(),
});

export const SessionResponseSchema = z.object({
  accessToken: z.string().min(16).max(8_192),
  refreshToken: z.string().min(8).max(2_048),
  /** Unix seconds. */
  expiresAt: z.number().int().positive(),
  user: CloudUserSchema,
});
export type CloudSession = z.infer<typeof SessionResponseSchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });
