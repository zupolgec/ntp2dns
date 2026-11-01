import type { Env } from "./env";

type CfResponse<T> = { success: boolean; result: T; errors?: { message: string }[] };
type CfRecord = { id: string; content: string };

async function cf<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const base = env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4";
  const res = await fetch(`${base}/zones/${env.CF_ZONE_ID}/dns_records${path}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as CfResponse<T>;
  if (!json.success) throw new Error(`Cloudflare ${method} ${path}: ${json.errors?.map((e) => e.message).join(", ")}`);
  return json.result;
}

function find(env: Env, name: string, type: string) {
  return cf<CfRecord[]>(env, "GET", `?name=${encodeURIComponent(name)}&type=${type}`);
}

export async function upsertRecord(env: Env, name: string, ip: string) {
  const type = ip.includes(":") ? "AAAA" : "A";
  const [existing] = await find(env, name, type);
  const record = { type, name, content: ip, ttl: 60, proxied: false };
  if (existing) await cf(env, "PATCH", `/${existing.id}`, record);
  else await cf(env, "POST", "", record);
}

export async function deleteRecords(env: Env, name: string) {
  for (const type of ["A", "AAAA"]) {
    for (const rec of await find(env, name, type)) await cf(env, "DELETE", `/${rec.id}`);
  }
}

// Keeps the old dyndns.org name in step during the migration.
export async function mirrorToDyn(env: Env, hostname: string, ip: string): Promise<string> {
  if (!env.DYN_USERNAME || !env.DYN_UPDATER_KEY) return "skipped";
  const url = `https://members.dyndns.org/v3/update?hostname=${encodeURIComponent(hostname)}&myip=${encodeURIComponent(ip)}`;
  try {
    const res = await fetch(url, {
      headers: {
        authorization: "Basic " + btoa(`${env.DYN_USERNAME}:${env.DYN_UPDATER_KEY}`),
        "user-agent": "ntp2dns/1.0",
      },
    });
    return (await res.text()).trim().slice(0, 100);
  } catch (e) {
    return `network: ${(e as Error).message}`.slice(0, 100);
  }
}
