import { env, exports } from "cloudflare:workers";
import { vi } from "vitest";

// Fake of the only third-party services the Worker talks to:
// the Cloudflare DNS API and members.dyndns.org.
export type FakeRecord = { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean };

export function fakeUpstreams() {
  const records: FakeRecord[] = [];
  const dynCalls: { url: URL; auth: string | null }[] = [];
  // Answers members.dyndns.org gives, in order; then "good <ip>".
  const dynAnswers: string[] = [];
  const cfCalls: { method: string; url: URL }[] = [];
  let nextId = 1;

  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);

    if (url.hostname === "api.cloudflare.com") {
      cfCalls.push({ method: req.method, url });
      if (req.headers.get("authorization") !== "Bearer cf-test-token") {
        return Response.json({ success: false, errors: [{ message: "auth" }] }, { status: 403 });
      }
      const base = "/client/v4/zones/zone1/dns_records";
      if (req.method === "GET" && url.pathname === base) {
        const found = records.filter(
          (r) => r.name === url.searchParams.get("name") && r.type === url.searchParams.get("type"),
        );
        return Response.json({ success: true, result: found });
      }
      if (req.method === "POST" && url.pathname === base) {
        const body = (await req.json()) as Omit<FakeRecord, "id">;
        const rec = { ...body, id: `rec${nextId++}` };
        records.push(rec);
        return Response.json({ success: true, result: rec });
      }
      const id = url.pathname.slice(base.length + 1);
      const rec = records.find((r) => r.id === id);
      if (!rec) return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
      if (req.method === "PATCH") {
        Object.assign(rec, await req.json());
        return Response.json({ success: true, result: rec });
      }
      if (req.method === "DELETE") {
        records.splice(records.indexOf(rec), 1);
        return Response.json({ success: true, result: { id } });
      }
    }

    if (url.hostname === "members.dyndns.org") {
      dynCalls.push({ url, auth: req.headers.get("authorization") });
      return new Response(dynAnswers.shift() ?? `good ${url.searchParams.get("myip")}`);
    }

    return realFetch(input as RequestInfo, init);
  });

  return { records, dynCalls, dynAnswers, cfCalls, restore: () => spy.mockRestore() };
}

export const ADMIN = "http://localhost";

export function fetchWorker(url: string, init?: RequestInit) {
  return exports.default.fetch(new Request(url, { redirect: "manual", ...init }));
}

export function basic(user: string, pass: string) {
  return "Basic " + btoa(`${user}:${pass}`);
}

export type NewDevice = {
  slug: string;
  label?: string;
  ntp?: boolean;
  legacy_hostname?: string;
};

// Creates a device through the panel, like the user would, and returns the
// password shown on its page.
export async function createDevice(d: NewDevice): Promise<string> {
  const form = new FormData();
  form.set("slug", d.slug);
  form.set("label", d.label ?? d.slug);
  if (d.ntp) form.set("ntp", "on");
  form.set("legacy_hostname", d.legacy_hostname ?? "");
  form.set("alert_hours", "24");
  const res = await fetchWorker(`${ADMIN}/admin/devices`, {
    method: "POST",
    body: form,
    headers: { origin: ADMIN },
  });
  if (res.status !== 303) {
    const html = await res.text();
    const shown = html.match(/<p class="error">([^<]*)<\/p>/)?.[1];
    throw new Error(`create failed ${res.status}: ${shown ?? html}`);
  }
  // NTP devices never send a password, so their page doesn't show one.
  return d.ntp ? "" : shownPassword(res.headers.get("location")!);
}

// Saves the device's edit form, like the user would.
export async function editDevice(slug: string, d: Omit<NewDevice, "slug">) {
  const form = new FormData();
  form.set("label", d.label ?? slug);
  if (d.ntp) form.set("ntp", "on");
  form.set("legacy_hostname", d.legacy_hostname ?? "");
  form.set("alert_hours", "24");
  const res = await fetchWorker(`${ADMIN}/admin/devices/${await deviceId(slug)}`, {
    method: "POST",
    body: form,
    headers: { origin: ADMIN },
  });
  if (res.status !== 303) throw new Error(`edit failed ${res.status}`);
}

export async function shownPassword(devicePath: string): Promise<string> {
  const html = await (await fetchWorker(`${ADMIN}${devicePath}`)).text();
  const m = html.match(/data-secret="([^"]+)"/);
  if (!m) throw new Error("no password on the device page");
  return m[1];
}

export async function deviceId(slug: string): Promise<number> {
  return (await env.DB.prepare("select id from devices where slug = ?").bind(slug).first<{ id: number }>())!.id;
}
