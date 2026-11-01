# ntp2dns

Dynamic DNS for devices behind a changing IP, on Cloudflare, including devices
that can't do dynamic DNS at all.

Routers, NVRs and cameras often only know a handful of DynDNS providers, and
some of them get even that wrong. Almost all of them, though, ask a time server
for the time. **ntp2dns** gives every device its own NTP port on a server you
control: when a device asks for the time, the answer comes from the server's
synced clock and the address the request came from becomes the device's DNS
record.

Devices that can speak DynDNS get a standard dyndns2 endpoint instead.

```
 device ──NTP, port 55123──▶ ntp-agent (your server) ──HTTPS──▶ Worker ──API──▶ Cloudflare DNS
 router ──dyndns2 /nic/update──────────────────────────────────▶ Worker            front-gate.dyn.example.com
```

## Parts

- **`worker/`**: a Cloudflare Worker with D1.
  - dyndns2 endpoint (`/nic/update`, `/v3/update`) with per-device credentials,
    IPv4 and IPv6, DNS touched only when the address changes.
  - Optional mirroring to an old `*.dyndns.org` name, so devices can be moved
    over one at a time.
  - Optional plain `/?host=<old name>` link for devices that can only call a
    fixed URL (off by default, per device).
  - A small admin panel on `/admin` behind Cloudflare Access: devices, current
    IP, last contact, "not responding" flag, IP history, credentials, NTP ports.
    English or Italian.
- **`ntp-agent/`**: a single static Go binary for a server with a fixed IP.
  - One UDP port per device, from the list kept in the panel (reloaded every
    minute, cached on disk in case the Worker is unreachable at start).
  - Answers from the server's own clock (kept in sync by the OS): it never
    queries an upstream server per request. If the OS reports the clock as
    unsynchronised, the answer says so, so devices don't trust a wrong time.
  - Reports an address only when it changes, plus a heartbeat every 15 minutes.
  - Per-source rate limit; answers only client requests (no control or private
    modes) and never with more bytes than it received.

## Set up

### Worker

```bash
cd worker
pnpm install
cp wrangler.jsonc wrangler.production.jsonc     # fill in your values
pnpm exec wrangler d1 create ddns                # put the id in the config
pnpm exec wrangler d1 migrations apply ddns --remote -c wrangler.production.jsonc
pnpm exec wrangler secret put CF_API_TOKEN -c wrangler.production.jsonc   # Zone > DNS > Edit, that zone only
pnpm exec wrangler secret put AGENT_TOKEN -c wrangler.production.jsonc    # long random string
pnpm exec wrangler deploy -c wrangler.production.jsonc
```

Create a Cloudflare Access application for `<your host>/admin*`. The Worker also
verifies the Access token itself (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`), so the
panel answers 403 if the Access policy is ever missing.

To keep old `*.dyndns.org` names updated while migrating, also set
`DYN_USERNAME` and `DYN_UPDATER_KEY`.

### NTP agent

```bash
cd ntp-agent
make                                   # dist/ntp-agent-linux-amd64
scp dist/ntp-agent-linux-amd64 server:/usr/local/bin/ntp-agent
scp deploy/ntp-agent.service server:/etc/systemd/system/
# on the server: /etc/ntp-agent/env (root, 0600)
#   DDNS_API=https://ddns.example.com
#   DDNS_AGENT_TOKEN=<AGENT_TOKEN>
systemctl enable --now ntp-agent
ntp-agent probe <server-ip>:55123      # from outside, once a device has that port
```

Open the UDP port range you hand out (`NTP_PORT_MIN`–`NTP_PORT_MAX`) in the
server's firewall. Run `ntp-agent serve -h` for all options.

### Devices

- **DynDNS-capable**: provider "DynDNS" or "custom", server `<your host>`,
  username and password from the panel, hostname `<name>.<zone>`. Generic URL:
  `https://<name>:<password>@<your host>/nic/update?hostname=<name>.<zone>&myip=<ip>`.
- **Anything else**: set the time server to `<agent ip>` and the port shown in
  the panel.

## Develop

```bash
cd worker && pnpm test          # runs in the Workers runtime; only the Cloudflare API and dyndns.org are mocked
cd ntp-agent && make test
```

Local end-to-end run, with a fake Cloudflare DNS API:

```bash
cd worker
cat > .dev.vars <<'EOF'
ADMIN_AUTH_DISABLED=true
AGENT_TOKEN=dev-agent-token
CF_API_TOKEN=dev
CF_API_BASE=http://127.0.0.1:18788
EOF
pnpm exec wrangler d1 migrations apply ddns --local
pnpm dev:fake-cloudflare &
pnpm dev                        # http://localhost:8787/admin (no Access on localhost)

cd ../ntp-agent
go build -o /tmp/ntp-agent . && DDNS_AGENT_TOKEN=dev-agent-token /tmp/ntp-agent serve -api http://localhost:8787 -listen 127.0.0.1 -cache /tmp/ports.json
```

`ADMIN_AUTH_DISABLED` is only honoured for requests to `localhost`.

## License

MIT
