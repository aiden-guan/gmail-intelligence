# Security

## Reporting

Please report security issues privately to the repository maintainers. Do not open public issues that include secrets or personal email data.

## Hard rules

- Never commit API keys, Supabase service role keys, or personal tokens.
- Extension content scripts and MAIN world must never receive provider keys, tracker tokens, or Supabase secrets.
- Tracking pixel/click endpoints are public by design; management APIs require `Authorization: Bearer <PERSONAL_API_TOKEN>`.
- Click redirects allow only `http:` / `https:` destinations.
- Sanitize email-derived HTML before rendering in React UI.
- Do not introduce Gmail API OAuth scopes or undocumented Gmail write endpoints.

## Threat notes

Open tracking can be spoofed or blocked. Treat events as signals (“Open detected”), not proof of human read. Self-open heuristics hide likely self events by default but do not delete them.
