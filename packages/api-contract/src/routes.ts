import type { z } from 'zod';
import {
  AccountDeleteRequestSchema,
  BillingCheckoutRequestSchema,
  BillingPortalRequestSchema,
  BillingRedirectResponseSchema,
  CapabilitiesResponseSchema,
  EntitlementsResponseSchema,
  HealthResponseSchema,
  MeResponseSchema,
  VersionResponseSchema,
} from './account.js';
import {
  AskRequestSchema,
  AskResponseSchema,
  ClassifyRequestSchema,
  ClassifyResponseSchema,
  DraftRequestSchema,
  DraftResponseSchema,
  EmbedRequestSchema,
  EmbedResponseSchema,
  RewriteRequestSchema,
  RewriteResponseSchema,
  SummarizeRequestSchema,
  SummarizeResponseSchema,
  type AiOperation,
} from './ai.js';
import {
  OkResponseSchema,
  RefreshRequestSchema,
  SessionResponseSchema,
  SignOutRequestSchema,
  TokenExchangeRequestSchema,
} from './auth.js';

export type RouteAuth = 'none' | 'user';

export type RouteDef = {
  method: 'GET' | 'POST';
  path: string;
  auth: RouteAuth;
  request?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  /** Set on routes that run inference; these are metered and entitlement-checked. */
  operation?: AiOperation;
};

/**
 * The canonical PigeonBox Cloud route table. The client and the server both
 * build from this object, so a route cannot exist on one side only.
 */
export const ROUTES = {
  health: { method: 'GET', path: '/v1/health', auth: 'none', response: HealthResponseSchema },
  version: { method: 'GET', path: '/v1/version', auth: 'none', response: VersionResponseSchema },

  authToken: { method: 'POST', path: '/v1/auth/token', auth: 'none', request: TokenExchangeRequestSchema, response: SessionResponseSchema },
  authRefresh: { method: 'POST', path: '/v1/auth/refresh', auth: 'none', request: RefreshRequestSchema, response: SessionResponseSchema },
  authSignOut: { method: 'POST', path: '/v1/auth/signout', auth: 'user', request: SignOutRequestSchema, response: OkResponseSchema },

  me: { method: 'GET', path: '/v1/me', auth: 'user', response: MeResponseSchema },
  capabilities: { method: 'GET', path: '/v1/capabilities', auth: 'user', response: CapabilitiesResponseSchema },
  entitlements: { method: 'GET', path: '/v1/account/entitlements', auth: 'user', response: EntitlementsResponseSchema },
  accountDelete: { method: 'POST', path: '/v1/account/delete', auth: 'user', request: AccountDeleteRequestSchema, response: OkResponseSchema },

  billingCheckout: { method: 'POST', path: '/v1/billing/checkout', auth: 'user', request: BillingCheckoutRequestSchema, response: BillingRedirectResponseSchema },
  billingPortal: { method: 'POST', path: '/v1/billing/portal', auth: 'user', request: BillingPortalRequestSchema, response: BillingRedirectResponseSchema },

  classify: { method: 'POST', path: '/v1/ai/classify', auth: 'user', request: ClassifyRequestSchema, response: ClassifyResponseSchema, operation: 'classify' },
  summarize: { method: 'POST', path: '/v1/ai/summarize', auth: 'user', request: SummarizeRequestSchema, response: SummarizeResponseSchema, operation: 'summarize' },
  draft: { method: 'POST', path: '/v1/ai/draft', auth: 'user', request: DraftRequestSchema, response: DraftResponseSchema, operation: 'draft' },
  followUp: { method: 'POST', path: '/v1/ai/follow-up', auth: 'user', request: DraftRequestSchema, response: DraftResponseSchema, operation: 'follow_up' },
  rewrite: { method: 'POST', path: '/v1/ai/rewrite', auth: 'user', request: RewriteRequestSchema, response: RewriteResponseSchema, operation: 'rewrite' },
  ask: { method: 'POST', path: '/v1/ai/ask', auth: 'user', request: AskRequestSchema, response: AskResponseSchema, operation: 'ask' },
  embed: { method: 'POST', path: '/v1/ai/embed', auth: 'user', request: EmbedRequestSchema, response: EmbedResponseSchema, operation: 'embed' },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof ROUTES;
export type RouteRequest<N extends RouteName> = (typeof ROUTES)[N] extends { request: infer S extends z.ZodTypeAny }
  ? z.input<S>
  : never;
export type RouteResponse<N extends RouteName> = z.infer<(typeof ROUTES)[N]['response']>;

/**
 * Browser redirect (not JSON), so it lives outside ROUTES. Query shape is
 * `AuthorizeQuerySchema`.
 */
export const AUTHORIZE_PATH = '/v1/auth/authorize';

/**
 * Hosted tracker management routes. They reuse the self-host tracker protocol
 * (see @pigeonbox/tracking) and authenticate with the Cloud access token instead
 * of a personal token. Pixel and click routes stay public.
 */
export const TRACKER_PATHS = {
  health: '/health',
  emails: '/api/emails',
  recentEvents: '/api/events/recent',
  openPixelPrefix: '/open/',
  clickPrefix: '/c/',
} as const;
