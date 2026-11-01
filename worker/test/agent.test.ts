import { env } from "cloudflare:workers";
import app from "../src/index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, createDevice, deviceId, fakeUpstreams, fetchWorker } from "./helpers";

let up: ReturnType<typeof fakeUpstreams>;
beforeEach(() => {
  up = fakeUpstreams();
});
afterEach(() => up.restore());

const HOST = "https://ddns.example.test";
const auth = { authorization: "Bearer agent-secret" };

async function portOf(slug: string): Promise<number | undefined> {
  const res = await fetchWorker(`${HOST}/agent/config`, { headers: auth });
  const body = (await res.json()) as { ports: { port: number; device: string }[] };
  return body.ports.find((p) => p.device === slug)?.port;
}

function save(id: number, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return fetchWorker(`${ADMIN}/admin/devices/${id}`, { method: "POST", body: form, headers: { origin: ADMIN } });
}

describe("NTP agent API", () => {
  it("gives each NTP device its own port, and none to the others", async () => {
    await createDevice({ slug: "ntp-one", ntp: true });
    await createDevice({ slug: "ntp-one-b", ntp: true });
    await createDevice({ slug: "plain-dyndns" });
    const a = await portOf("ntp-one");
    const b = await portOf("ntp-one-b");
    expect(a).toBeGreaterThanOrEqual(55123);
    expect(b).toBeGreaterThanOrEqual(55123);
    expect(a).not.toBe(b);
    expect(await portOf("plain-dyndns")).toBeUndefined();
  });

  it("keeps the port while NTP stays on, and frees it when turned off", async () => {
    await createDevice({ slug: "ntp-toggle", ntp: true });
    const id = await deviceId("ntp-toggle");
    const port = await portOf("ntp-toggle");
    expect((await save(id, { label: "renamed", ntp: "on", alert_hours: "24" })).status).toBe(303);
    expect(await portOf("ntp-toggle")).toBe(port);
    expect((await save(id, { label: "renamed", alert_hours: "24" })).status).toBe(303);
    expect(await portOf("ntp-toggle")).toBeUndefined();
    expect((await save(id, { label: "renamed", ntp: "on", alert_hours: "24" })).status).toBe(303);
    expect(await portOf("ntp-toggle")).toBeGreaterThanOrEqual(55123);
  });

  it("updates DNS from the address seen on an NTP port", async () => {
    await createDevice({ slug: "ntp-two", ntp: true, legacy_hostname: "two.dyndns.org" });
    const port = await portOf("ntp-two");
    const res = await fetchWorker(`${HOST}/agent/report`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ reports: [{ port, ip: "203.0.113.70" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ port, result: "good" }] });
    expect(up.records).toMatchObject([{ name: "ntp-two.dyn.example.test", content: "203.0.113.70" }]);
    expect(up.dynCalls).toHaveLength(1);
  });

  it("reports unknown ports instead of failing the batch", async () => {
    const res = await fetchWorker(`${HOST}/agent/report`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ reports: [{ port: 59999, ip: "203.0.113.71" }] }),
    });
    expect(await res.json()).toEqual({ results: [{ port: 59999, result: "nohost" }] });
  });

  it("refuses a wrong agent token", async () => {
    const res = await fetchWorker(`${HOST}/agent/config`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("hands out ports only from the NTP_PORTS range", async () => {
    const narrow = { ...env, NTP_PORTS: "60001-60002" };
    const create = (slug: string) => {
      const form = new FormData();
      form.set("slug", slug);
      form.set("label", slug);
      form.set("ntp", "on");
      form.set("alert_hours", "24");
      return app.fetch(
        new Request(`${ADMIN}/admin/devices`, { method: "POST", body: form, headers: { origin: ADMIN }, redirect: "manual" }),
        narrow,
      );
    };
    expect((await create("range-a")).status).toBe(303);
    expect((await create("range-b")).status).toBe(303);
    const full = await create("range-c");
    expect(full.status).toBe(422);
    expect(await full.text()).toContain("no free time server (NTP) ports");
    const ports = [await portOf("range-a"), await portOf("range-b")].sort();
    expect(ports).toEqual([60001, 60002]);
  });
});
