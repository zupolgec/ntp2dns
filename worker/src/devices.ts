import { deleteRecords, mirrorToDyn, upsertRecord } from "./dns";
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

// Records that a device was seen at `ip`. DNS and the old dyndns.org name are
// touched only when the address actually changed.
export async function report(env: Env, device: Device, ip: string, source: Source): Promise<ReportResult> {
  const now = new Date().toISOString();
  const column = ip.includes(":") ? "ipv6" : "ipv4";

  if (device[column] === ip) {
    await env.DB.prepare("update devices set last_seen_at = ?, last_source = ? where id = ?")
      .bind(now, source, device.id)
      .run();
    return "nochg";
  }

  await upsertRecord(env, fqdn(env, device), ip);
  const mirror = device.legacy_hostname && column === "ipv4" ? await mirrorToDyn(env, device.legacy_hostname, ip) : null;

  await env.DB.batch([
    env.DB.prepare(
      `update devices set ${column} = ?, last_seen_at = ?, last_change_at = ?, last_source = ? where id = ?`,
    ).bind(ip, now, now, source, device.id),
    env.DB.prepare("insert into ip_history (device_id, ip, source, mirror_result, at) values (?, ?, ?, ?, ?)").bind(
      device.id,
      ip,
      source,
      mirror,
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
