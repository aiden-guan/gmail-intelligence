# Security policy

## Reporting a vulnerability

Report privately through [GitHub security advisories](https://github.com/aiden-guan/pigeonbox/security/advisories/new). Do not open a public issue, and do not include real email content, API keys or tokens in reports. We aim to acknowledge reports within a few days.

In scope: the extension in this repository, the self-hosted tracker (`workers/tracker`, `convex/`), and the PigeonBox Cloud API as reached from the extension.

## Rules the code follows

- No API keys, Supabase service-role keys, Stripe secrets or personal tokens in the repository or in extension builds. `npm run check:repo` and release packaging scan for them.
- Content scripts and Gmail's MAIN world never receive provider keys, tracker tokens, Cloud tokens or full settings. Extension storage is restricted to trusted contexts.
- Privileged runtime messages are accepted only from extension pages.
- All executable code ships in the package; no remote code.
- Tracking pixel and click routes are public by design; management APIs require a Bearer token (personal token, or a Cloud access token scoped to one account). Click redirects only allow `http:`/`https:`.
- Email HTML is reduced to text before display in PigeonBox UI.
- No Gmail API OAuth scopes and no undocumented Gmail write endpoints.
- PigeonBox never sends email without the user.

The full analysis is in [docs/threat-model.md](docs/threat-model.md).

## Notes on tracking

Open tracking can be spoofed or blocked; events are signals ("Open detected"), not proof of reading. Suspected self-opens are hidden, not deleted.
