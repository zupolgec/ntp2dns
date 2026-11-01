import { env } from "cloudflare:workers";
import app from "../src/index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, basic, createDevice, fakeUpstreams, fetchWorker } from "./helpers";

let up: ReturnType<typeof fakeUpstreams>;
beforeEach(() => {
  up = fakeUpstreams();
});
afterEach(() => up.restore());

describe("panel", () => {
  it("is not reachable without Cloudflare Access outside local development", async () => {
    const res = await fetchWorker("https://ddns.example.test/admin");
    expect(res.status).toBe(403);
  });

  it("lists devices with their current IP", async () => {
    const pass = await createDevice({ slug: "list-me", label: "Front gate NVR" });
    await fetchWorker("https://ddns.example.test/nic/update?hostname=list-me.dyn.example.test&myip=203.0.113.90", {
      headers: { authorization: basic("list-me", pass) },
    });
    const html = await (await fetchWorker(`${ADMIN}/admin`)).text();
    expect(html).toContain("Front gate NVR");
    expect(html).toContain("203.0.113.90");
  });

  it("rejects form posts from another site", async () => {
    const form = new FormData();
    form.set("slug", "evil");
    const res = await fetchWorker(`${ADMIN}/admin/devices`, {
      method: "POST",
      body: form,
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects invalid device names", async () => {
    await expect(createDevice({ slug: "Bad Name!" })).rejects.toThrow(/name/i);
  });

  it("stores only a hash of the device password", async () => {
    const pass = await createDevice({ slug: "hash-check" });
    const row = await env.DB.prepare("select * from devices where slug = ?").bind("hash-check").first();
    expect(JSON.stringify(row)).not.toContain(pass);
  });

  it("rotating the password invalidates the old one", async () => {
    const old = await createDevice({ slug: "rotate-me" });
    const id = (await env.DB.prepare("select id from devices where slug = ?").bind("rotate-me").first<{ id: number }>())!.id;
    const res = await fetchWorker(`${ADMIN}/admin/devices/${id}/rotate`, { method: "POST", headers: { origin: ADMIN } });
    const fresh = (await res.text()).match(/data-secret="([^"]+)"/)![1];
    const url = "https://ddns.example.test/nic/update?hostname=rotate-me.dyn.example.test&myip=203.0.113.91";
    expect(await (await fetchWorker(url, { headers: { authorization: basic("rotate-me", old) } })).text()).toBe("badauth");
    expect(await (await fetchWorker(url, { headers: { authorization: basic("rotate-me", fresh) } })).text()).toBe(
      "good 203.0.113.91",
    );
  });

  it("deleting a device removes its DNS records", async () => {
    const pass = await createDevice({ slug: "delete-me" });
    await fetchWorker("https://ddns.example.test/nic/update?hostname=delete-me.dyn.example.test&myip=203.0.113.92", {
      headers: { authorization: basic("delete-me", pass) },
    });
    expect(up.records).toHaveLength(1);
    const id = (await env.DB.prepare("select id from devices where slug = ?").bind("delete-me").first<{ id: number }>())!.id;
    const res = await fetchWorker(`${ADMIN}/admin/devices/${id}/delete`, { method: "POST", headers: { origin: ADMIN } });
    expect(res.status).toBe(303);
    expect(up.records).toHaveLength(0);
  });

  it("keeps names that would clash with common service names for itself", async () => {
    await expect(createDevice({ slug: "www" })).rejects.toThrow(/reserved/i);
    await expect(createDevice({ slug: "ddns" })).rejects.toThrow(/reserved/i);
  });

  it("speaks English by default and Italian when configured", async () => {
    const en = await (await fetchWorker(`${ADMIN}/admin/devices/new`)).text();
    expect(en).toContain("New device");
    const it = await (
      await app.fetch(new Request(`${ADMIN}/admin/devices/new`), { ...env, PANEL_LANG: "it" })
    ).text();
    expect(it).toContain("Nuovo apparato");
    expect(it).toContain('lang="it"');
  });
});
