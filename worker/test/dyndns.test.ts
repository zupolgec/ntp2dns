import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { basic, createDevice, deviceId, editDevice, fakeUpstreams, fetchWorker } from "./helpers";

let up: ReturnType<typeof fakeUpstreams>;
beforeEach(() => {
  up = fakeUpstreams();
});
afterEach(() => up.restore());

const HOST = "https://ddns.example.test";

describe("dyndns2 update endpoint", () => {
  it("creates the A record on first update and answers good", async () => {
    const pass = await createDevice({ slug: "nvr-front" });
    const res = await fetchWorker(`${HOST}/nic/update?hostname=nvr-front.dyn.example.test&myip=203.0.113.7`, {
      headers: { authorization: basic("nvr-front", pass) },
    });
    expect(await res.text()).toBe("good 203.0.113.7");
    expect(up.records).toMatchObject([
      { type: "A", name: "nvr-front.dyn.example.test", content: "203.0.113.7", proxied: false },
    ]);
  });

  it("answers nochg without touching DNS when the IP is unchanged", async () => {
    const pass = await createDevice({ slug: "nvr-same" });
    const url = `${HOST}/nic/update?hostname=nvr-same.dyn.example.test&myip=203.0.113.8`;
    const headers = { authorization: basic("nvr-same", pass) };
    await fetchWorker(url, { headers });
    const callsAfterFirst = up.cfCalls.length;
    const res = await fetchWorker(url, { headers });
    expect(await res.text()).toBe("nochg 203.0.113.8");
    expect(up.cfCalls.length).toBe(callsAfterFirst);
  });

  it("updates the existing record when the IP changes", async () => {
    const pass = await createDevice({ slug: "nvr-move" });
    const headers = { authorization: basic("nvr-move", pass) };
    await fetchWorker(`${HOST}/nic/update?hostname=nvr-move.dyn.example.test&myip=203.0.113.9`, { headers });
    const res = await fetchWorker(`${HOST}/v3/update?hostname=nvr-move.dyn.example.test&myip=198.51.100.4`, {
      headers,
    });
    expect(await res.text()).toBe("good 198.51.100.4");
    expect(up.records.filter((r) => r.name === "nvr-move.dyn.example.test")).toMatchObject([
      { type: "A", content: "198.51.100.4" },
    ]);
  });

  it("uses the caller's address when myip is missing", async () => {
    const pass = await createDevice({ slug: "router-noip" });
    const res = await fetchWorker(`${HOST}/nic/update?hostname=router-noip.dyn.example.test`, {
      headers: { authorization: basic("router-noip", pass), "cf-connecting-ip": "192.0.2.55" },
    });
    expect(await res.text()).toBe("good 192.0.2.55");
  });

  it("writes an AAAA record for IPv6 and handles both families in one call", async () => {
    const pass = await createDevice({ slug: "dual" });
    const res = await fetchWorker(`${HOST}/nic/update?hostname=dual.dyn.example.test&myip=203.0.113.20,2001:db8::1`, {
      headers: { authorization: basic("dual", pass) },
    });
    expect(await res.text()).toBe("good 203.0.113.20,2001:db8::1");
    expect(up.records.map((r) => r.type).sort()).toEqual(["A", "AAAA"]);
  });

  it("rejects a wrong password with badauth", async () => {
    await createDevice({ slug: "nvr-auth" });
    const res = await fetchWorker(`${HOST}/nic/update?hostname=nvr-auth.dyn.example.test&myip=203.0.113.1`, {
      headers: { authorization: basic("nvr-auth", "wrong") },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("badauth");
    expect(up.records).toEqual([]);
  });

  it("asks for credentials when none are sent", async () => {
    const res = await fetchWorker(`${HOST}/nic/update?hostname=x.dyn.example.test`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("refuses to update a hostname that belongs to another device", async () => {
    const pass = await createDevice({ slug: "nvr-a" });
    await createDevice({ slug: "nvr-b" });
    const res = await fetchWorker(`${HOST}/nic/update?hostname=nvr-b.dyn.example.test&myip=203.0.113.1`, {
      headers: { authorization: basic("nvr-a", pass) },
    });
    expect(await res.text()).toBe("nohost");
    expect(up.records).toEqual([]);
  });

  it("rejects an invalid IP", async () => {
    const pass = await createDevice({ slug: "nvr-badip" });
    const res = await fetchWorker(`${HOST}/nic/update?hostname=nvr-badip.dyn.example.test&myip=999.1.1.1`, {
      headers: { authorization: basic("nvr-badip", pass) },
    });
    expect(await res.text()).toBe("notfqdn");
  });

  it("mirrors the change to the old dyndns.org name when one is set", async () => {
    const pass = await createDevice({ slug: "nvr-mirror", legacy_hostname: "mirror.dyndns.org" });
    await fetchWorker(`${HOST}/nic/update?hostname=nvr-mirror.dyn.example.test&myip=203.0.113.30`, {
      headers: { authorization: basic("nvr-mirror", pass) },
    });
    expect(up.dynCalls).toHaveLength(1);
    expect(up.dynCalls[0].url.searchParams.get("hostname")).toBe("mirror.dyndns.org");
    expect(up.dynCalls[0].url.searchParams.get("myip")).toBe("203.0.113.30");
    expect(up.dynCalls[0].auth).toBe(basic("dynuser", "dynkey"));
  });

  describe("old dyndns.org name", () => {
    const update = (slug: string, pass: string, ip: string) =>
      fetchWorker(`${HOST}/nic/update?hostname=${slug}.dyn.example.test&myip=${ip}`, {
        headers: { authorization: basic(slug, pass) },
      });
    // Moves the last attempt on the old name back in time.
    const later = async (slug: string, minutes: number) =>
      env.DB.prepare("update devices set legacy_at = ? where id = ?")
        .bind(new Date(Date.now() - minutes * 60_000).toISOString(), await deviceId(slug))
        .run();

    it("is updated again after a temporary failure, even if the address stays the same", async () => {
      const pass = await createDevice({ slug: "mirror-911", legacy_hostname: "m911.dyndns.org" });
      up.dynAnswers.push("911");
      await update("mirror-911", pass, "203.0.113.32");
      await update("mirror-911", pass, "203.0.113.32");
      expect(up.dynCalls).toHaveLength(1); // DynDNS asks for 30 minutes of quiet after 911

      await later("mirror-911", 31);
      expect(await (await update("mirror-911", pass, "203.0.113.32")).text()).toBe("nochg 203.0.113.32");
      expect(up.dynCalls).toHaveLength(2);

      await later("mirror-911", 31);
      await update("mirror-911", pass, "203.0.113.32");
      expect(up.dynCalls).toHaveLength(2);
    });

    it("is not tried again after a refusal until the address changes", async () => {
      const pass = await createDevice({ slug: "mirror-auth", legacy_hostname: "mauth.dyndns.org" });
      up.dynAnswers.push("badauth");
      await update("mirror-auth", pass, "203.0.113.33");
      await later("mirror-auth", 31);
      await update("mirror-auth", pass, "203.0.113.33");
      expect(up.dynCalls).toHaveLength(1);
    });

    it("is updated when added to a device that already has an address", async () => {
      const pass = await createDevice({ slug: "mirror-late" });
      await update("mirror-late", pass, "203.0.113.34");
      expect(up.dynCalls).toHaveLength(0);

      await editDevice("mirror-late", { legacy_hostname: "late.dyndns.org" });
      await update("mirror-late", pass, "203.0.113.34");
      expect(up.dynCalls.map((c) => c.url.searchParams.get("hostname"))).toEqual(["late.dyndns.org"]);
      await update("mirror-late", pass, "203.0.113.34");
      expect(up.dynCalls).toHaveLength(1);
    });
  });

  it("also accepts the old dyndns.org name as hostname, for devices that cannot change it", async () => {
    const pass = await createDevice({ slug: "nvr-oldname", legacy_hostname: "oldname.dyndns.org" });
    const res = await fetchWorker(`${HOST}/nic/update?hostname=oldname.dyndns.org&myip=203.0.113.31`, {
      headers: { authorization: basic("nvr-oldname", pass) },
    });
    expect(await res.text()).toBe("good 203.0.113.31");
  });
});

describe("old /?host= link", () => {
  it("is gone: the root only leads to the panel and never touches DNS", async () => {
    await createDevice({ slug: "old-on", legacy_hostname: "on.dyndns.org" });

    const res = await fetchWorker(`http://ddns.example.test/?host=on.dyndns.org`, {
      headers: { "cf-connecting-ip": "203.0.113.40" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin");
    expect(up.records).toEqual([]);
  });
});
