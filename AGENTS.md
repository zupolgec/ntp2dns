# ntp2dns

Dynamic DNS through NTP: a Go agent (`ntp-agent/`) that gives each device an
NTP port and updates its name with any dyndns2 provider (config file) or with
the optional Cloudflare backend: Worker + D1 with dyndns2 endpoint and admin
panel (`worker/`). Keep the agent provider-independent. See `README.md`.
Public, MIT.

- Everything committed here is public: no client names, internal hosts, IPs or
  deployment notes. Real deployments use `worker/wrangler.production.jsonc`
  (gitignored); their notes live outside this repo.
- Project docs go in `docs/` (English) and are committed.
- Panel copy: English base strings in `worker/src/i18n.ts`, Italian translation
  next to them. User-facing text only, no implementation details.
- Tests first. Worker: `pnpm test` in `worker/` (only the Cloudflare API and
  members.dyndns.org are mocked; test env vars are pinned in `vitest.config.ts`
  so `.dev.vars` never leaks in). Agent: `make test` in `ntp-agent/`.
