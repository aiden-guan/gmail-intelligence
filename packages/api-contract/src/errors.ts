import { z } from 'zod';

/**
 * Normalized error codes. HTTP status is fixed per code so clients can rely on
 * either. Messages are safe to show users and never contain mailbox content.
 */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  invalid_token: 401,
  entitlement_required: 402,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_protocol: 426,
  rate_limited: 429,
  quota_exceeded: 429,
  internal: 500,
  not_configured: 501,
  provider_error: 502,
  provider_invalid_response: 502,
  provider_unavailable: 503,
  provider_rate_limited: 503,
  provider_timeout: 504,
} as const;

export type CloudErrorCode = keyof typeof ERROR_STATUS;

export const RETRYABLE_ERRORS: ReadonlySet<CloudErrorCode> = new Set<CloudErrorCode>([
  'rate_limited',
  'internal',
  'provider_error',
  'provider_unavailable',
  'provider_rate_limited',
  'provider_timeout',
]);

export const ErrorBodySchema = z.object({
  error: z.object({
    /** Lenient so a newer server can add codes. */
    code: z.string().max(64),
    message: z.string().max(500),
    retryable: z.boolean(),
    requestId: z.string().max(128).optional(),
    /** Seconds until a retry can succeed, for rate limits. */
    retryAfter: z.number().int().nonnegative().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export function isKnownErrorCode(code: string): code is CloudErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_STATUS, code);
}

export function errorBody(
  code: CloudErrorCode,
  message: string,
  extra?: { requestId?: string; retryAfter?: number },
): ErrorBody {
  return {
    error: {
      code,
      message: message.slice(0, 500),
      retryable: RETRYABLE_ERRORS.has(code),
      ...(extra?.requestId ? { requestId: extra.requestId } : {}),
      ...(extra?.retryAfter !== undefined ? { retryAfter: extra.retryAfter } : {}),
    },
  };
}
