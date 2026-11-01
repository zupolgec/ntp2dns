import type { Context } from "hono";
import { sha256, safeEqual } from "./crypto";
import { fqdn, getByLegacyHttp, getBySlug, parseIp, report } from "./devices";
import type { Env } from "./env";

type C = Context<{ Bindings: Env }>;

const text = (c: C, body: string, status: 200 | 401 = 200) => c.text(body, status);

function callerIp(c: C): string | null {
  return parseIp(c.req.header("cf-connecting-ip") ?? "");
}

function credentials(c: C): [string, string] | null {
  const h = c.req.header("authorization") ?? "";
  if (!h.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = atob(h.slice(6));
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  return i < 0 ? null : [decoded.slice(0, i), decoded.slice(i + 1)];
}

// dyndns2 protocol: GET /nic/update?hostname=a[,b]&myip=v4[,v6] with Basic auth.
export async function nicUpdate(c: C) {
  const creds = credentials(c);
  if (!creds) {
    c.header("www-authenticate", 'Basic realm="ddns"');
    return text(c, "badauth", 401);
  }
  const device = await getBySlug(c.env, creds[0].toLowerCase());
  if (!device || !safeEqual(device.password_hash, await sha256(creds[1]))) return text(c, "badauth", 401);
  if (!device.enabled) return text(c, "nohost");

  const hostnames = (c.req.query("hostname") ?? "").toLowerCase().split(",").filter(Boolean);
  if (hostnames.length === 0) return text(c, "notfqdn");
  const own = [fqdn(c.env, device), device.legacy_hostname].filter(Boolean);
  if (!hostnames.every((h) => own.includes(h))) return text(c, "nohost");

  const rawIps = c.req.query("myip");
  const ips = rawIps ? rawIps.split(",").filter(Boolean).map(parseIp) : [callerIp(c)];
  if (ips.length === 0 || ips.length > 2 || ips.some((ip) => ip === null)) return text(c, "notfqdn");

  let changed = false;
  for (const ip of ips as string[]) {
    if ((await report(c.env, device, ip, "dyndns")) === "good") changed = true;
  }
  const line = `${changed ? "good" : "nochg"} ${ips.join(",")}`;
  // One answer line per hostname, as dyndns2 clients expect.
  return text(c, hostnames.map(() => line).join("\n"));
}

// Plain GET /?host=<old name> link, for devices that can only call a fixed URL
// (this is how the original setup worked). No credentials, so it only works for devices
// flagged for it in the panel.
export async function legacyHttp(c: C) {
  const host = c.req.query("host");
  if (!host) return c.notFound();
  const device = await getByLegacyHttp(c.env, host);
  const ip = callerIp(c);
  if (!device || !ip) return text(c, "nohost");
  return text(c, `${await report(c.env, device, ip, "http")} ${ip}`);
}
