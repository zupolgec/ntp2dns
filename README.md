# ntp2dns

Dynamic DNS for devices that can't do dynamic DNS, using the one thing they all
do: ask for the time.

Routers, NVRs and cameras often only know a handful of DynDNS providers, and
some of them get even that wrong. Almost all of them, though, ask a time server
for the time. **ntp2dns** gives every device its own NTP port on a server you
control: when a device asks for the time, it gets a correct answer from the
server's clock, and the address it called from goes to its dynamic DNS
provider.

It works with any provider that speaks the dyndns2 protocol (DynDNS, No-IP,
deSEC, Dynu, your own server...) or takes the address in a URL (Duck DNS and
similar). Nothing about it is tied to one DNS host.

```
 device ──NTP, port 55123──▶ ntp-agent (your server) ──dyndns2──▶ any DynDNS provider
```

If you'd rather run the whole thing yourself, the repository also has an
optional backend for Cloudflare: a Worker that keeps the device list, manages
the DNS records in your own zone and gives you a small admin panel.

```
 device ──NTP, port 55123──▶ ntp-agent ──HTTPS──▶ Worker ──API──▶ Cloudflare DNS
 router ──dyndns2 /nic/update────────────────────▶ Worker
```

## Parts

- **`ntp-agent/`**: a single static Go binary for a server with a fixed IP.
  - One UDP port per device. The list comes from a config file, or from the
    Worker's panel.
  - Answers from the server's own clock (kept in sync by the OS): it never
    queries an upstream server per request. If the OS reports the clock as
    unsynchronised, the answer says so, so devices don't trust a wrong time.
  - Sends an update only when a device's address changes. Temporary provider
    errors are retried with backoff; refusals (wrong password, unknown host,
    abuse) are logged and not repeated, so the account doesn't get blocked.
  - Per-source rate limit; answers only client requests (no control or private
    modes) and never with more bytes than it received.
- **`worker/`** (optional): a Cloudflare Worker with D1.
  - dyndns2 endpoint (`/nic/update`, `/v3/update`) with per-device credentials,
    IPv4 and IPv6, DNS touched only when the address changes.
  - A small admin panel on `/admin` behind Cloudflare Access: devices, current
    IP, last contact, "not responding" flag, IP history, credentials, NTP ports.
    English or Italian.
  - Optional mirroring to an old `*.dyndns.org` name, so devices can be moved
    over one at a time.

## NTP agent

```bash
cd ntp-agent
make                                   # dist/ntp-agent-linux-amd64
scp dist/ntp-agent-linux-amd64 server:/usr/local/bin/ntp-agent
scp deploy/ntp-agent.service server:/etc/systemd/system/
```

Open the UDP ports you hand out in the server's firewall, then point each
device's time server at `<server ip>` and its port. `ntp-agent probe
<server-ip>:55123` checks a port from outside; `ntp-agent serve -h` lists all
options.

### With any dynamic DNS provider

List the devices in `/etc/ntp-agent/devices.json` (root, 0600), see
[`deploy/devices.example.json`](ntp-agent/deploy/devices.example.json):

| field | |
| --- | --- |
| `port` | the device's NTP port |
| `url` | the provider's update URL. The agent adds `hostname` and `myip`, as in dyndns2. If the URL contains `{ip}`, the address goes there instead and nothing is added. |
| `hostname` | the name to update (dyndns2) |
| `username`, `password` | sent as HTTP basic auth, if set |
| `name` | shown in the logs (default: `hostname`) |

```bash
mkdir -p /etc/systemd/system/ntp-agent.service.d
cp deploy/ntp-agent-config.conf /etc/systemd/system/ntp-agent.service.d/config.conf
systemctl daemon-reload && systemctl enable --now ntp-agent
```

The agent reads the file at start: restart it after editing.

### With the Worker

```bash
# /etc/ntp-agent/env (root, 0600)
#   DDNS_API=https://ddns.example.com
#   DDNS_AGENT_TOKEN=<AGENT_TOKEN>
systemctl enable --now ntp-agent
```

Ports are managed in the panel: the agent reloads the list every minute and
keeps a copy on disk in case the Worker is unreachable at start. It also sends
a heartbeat every 15 minutes, so the panel can tell a device that went silent.

## Worker (Cloudflare)

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

Devices that can speak DynDNS can use the Worker directly: provider "DynDNS" or
"custom", server `<your host>`, username and password from the panel, hostname
`<name>.<zone>`. Generic URL:
`https://<name>:<password>@<your host>/nic/update?hostname=<name>.<zone>&myip=<ip>`.

## Develop

```bash
cd ntp-agent && make test
cd worker && pnpm test          # runs in the Workers runtime; only the Cloudflare API and dyndns.org are mocked
```

Local end-to-end run of the Worker, with a fake Cloudflare DNS API:

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
