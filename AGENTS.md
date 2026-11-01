# ntp2dns

Dynamic DNS on Cloudflare: Worker + D1 with dyndns2 endpoint and admin panel
(`worker/`), and a Go NTP agent (`ntp-agent/`). See `README.md`. Public, MIT.

- Everything committed here is public: no client names, internal hosts, IPs or
  deployment notes. Real deployments use `worker/wrangler.production.jsonc`
  (gitignored); their notes live outside this repo.
- Project docs go in `docs/` (English) and are committed.
- Panel copy: English base strings in `worker/src/i18n.ts`, Italian translation
  next to them. User-facing text only, no implementation details.
- Tests first. Worker: `pnpm test` in `worker/` (only the Cloudflare API and
  members.dyndns.org are mocked; test env vars are pinned in `vitest.config.ts`
  so `.dev.vars` never leaks in). Agent: `make test` in `ntp-agent/`.
