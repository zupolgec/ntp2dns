import { deleteRecords, MIRROR_RETRY_MS, mirrorTemporary, mirrorToDyn, upsertRecord } from "./dns";
import type { Device, Env, Source } from "./env";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function fqdn(env: Env, d: Pick<Device, "slug">) {
  return `${d.slug}.${env.ZONE_NAME}`;
}

// Returns the normalised address, or null when it is not a valid IPv4/IPv6.
export function parseIp(raw: string): string | null {
  const ip = raw.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((o) => Number(o) <= 255 && String(Number(o)) === o) ? ip : null;
  }
  if (/^[0-9a-fA-F:.]+$/.test(ip) && ip.includes(":")) {
    try {
      return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  return null;
}

export const getBySlug = (env: Env, slug: string) =>
  env.DB.prepare("select * from devices where slug = ?").bind(slug).first<Device>();

export const getById = (env: Env, id: number) =>
  env.DB.prepare("select * from devices where id = ?").bind(id).first<Device>();

export const getByPort = (env: Env, port: number) =>
  env.DB.prepare("select * from devices where ntp_port = ? and enabled = 1").bind(port).first<Device>();

export type ReportResult = "good" | "nochg";

// The old dyndns.org name gets the address when it hasn't had it yet, or again
// after a temporary failure once DynDNS's 30 minutes of quiet are over.
function mirrorDue(device: Device, ip: string, now: number): boolean {
  if (!device.legacy_hostname || ip.includes(":")) return false;
  if (device.legacy_ip !== ip) return true;
  return mirrorTemporary(device.legacy_result ?? "") && now - Date.parse(device.legacy_at ?? "") >= MIRROR_RETRY_MS;
}

async function mirror(env: Env, device: Device, ip: string, now: string): Promise<string | null> {
  if (!mirrorDue(device, ip, Date.parse(now))) return null;
  const result = await mirrorToDyn(env, device.legacy_hostname!, ip);
  if (result === "skipped") return result; // no DynDNS account yet: send it once there is
  await env.DB.prepare("update devices set legacy_ip = ?, legacy_result = ?, legacy_at = ? where id = ?")
    .bind(ip, result, now, device.id)
    .run();
  Object.assign(device, { legacy_ip: ip, legacy_result: result, legacy_at: now });
  return result;
}

// Records that a device was seen at `ip`. DNS is touched only when the address
// actually changed; the old dyndns.org name follows its own state.
export async function report(env: Env, device: Device, ip: string, source: Source): Promise<ReportResult> {
  const now = new Date().toISOString();
  const column = ip.includes(":") ? "ipv6" : "ipv4";

  if (device[column] === ip) {
    await env.DB.prepare("update devices set last_seen_at = ?, last_source = ? where id = ?")
      .bind(now, source, device.id)
      .run();
    await mirror(env, device, ip, now);
    return "nochg";
  }

  await upsertRecord(env, fqdn(env, device), ip);
  const mirrorResult = await mirror(env, device, ip, now);

  await env.DB.batch([
    env.DB.prepare(
      `update devices set ${column} = ?, last_seen_at = ?, last_change_at = ?, last_source = ? where id = ?`,
    ).bind(ip, now, now, source, device.id),
    env.DB.prepare("insert into ip_history (device_id, ip, source, mirror_result, at) values (?, ?, ?, ?, ?)").bind(
      device.id,
      ip,
      source,
      mirrorResult,
      now,
    ),
  ]);
  device[column] = ip;
  return "good";
}

export async function removeDevice(env: Env, device: Device) {
  await deleteRecords(env, fqdn(env, device));
  await env.DB.batch([
    env.DB.prepare("delete from ip_history where device_id = ?").bind(device.id),
    env.DB.prepare("delete from devices where id = ?").bind(device.id),
  ]);
}
