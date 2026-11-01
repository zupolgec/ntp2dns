import { env } from "cloudflare:workers";
import app from "../src/index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, basic, createDevice, deviceId, fakeUpstreams, fetchWorker, shownPassword } from "./helpers";

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

  it("keeps the password on the device page, hidden until clicked", async () => {
    const pass = await createDevice({ slug: "show-me" });
    const html = await (await fetchWorker(`${ADMIN}/admin/devices/${await deviceId("show-me")}`)).text();
    expect(html).toContain(`data-secret="${pass}"`);
    expect(html).toContain("Show password");
    expect(html).not.toMatch(/not be shown again/i);
  });

  it("a new password replaces the old one and is shown on the device page", async () => {
    const old = await createDevice({ slug: "rotate-me" });
    const id = await deviceId("rotate-me");
    const res = await fetchWorker(`${ADMIN}/admin/devices/${id}/rotate`, { method: "POST", headers: { origin: ADMIN } });
    expect(res.status).toBe(303);
    const fresh = await shownPassword(res.headers.get("location")!);
    expect(fresh).not.toBe(old);
    const url = "https://ddns.example.test/nic/update?hostname=rotate-me.dyn.example.test&myip=203.0.113.91";
    expect(await (await fetchWorker(url, { headers: { authorization: basic("rotate-me", old) } })).text()).toBe("badauth");
    expect(await (await fetchWorker(url, { headers: { authorization: basic("rotate-me", fresh) } })).text()).toBe(
      "good 203.0.113.91",
    );
  });

  it("asks only whether to use NTP: the port is assigned by the panel", async () => {
    const html = await (await fetchWorker(`${ADMIN}/admin/devices/new`)).text();
    expect(html).toContain('name="ntp"');
    expect(html).not.toContain('name="ntp_port"');
  });

  it("deleting a device removes its DNS records", async () => {
    const pass = await createDevice({ slug: "delete-me" });
    await fetchWorker("https://ddns.example.test/nic/update?hostname=delete-me.dyn.example.test&myip=203.0.113.92", {
      headers: { authorization: basic("delete-me", pass) },
    });
    expect(up.records).toHaveLength(1);
    const id = await deviceId("delete-me");
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
