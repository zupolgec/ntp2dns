import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevice, fakeUpstreams, fetchWorker } from "./helpers";

let up: ReturnType<typeof fakeUpstreams>;
beforeEach(() => {
  up = fakeUpstreams();
});
afterEach(() => up.restore());

const HOST = "https://ddns.example.test";
const auth = { authorization: "Bearer agent-secret" };

describe("NTP agent API", () => {
  it("lists the NTP ports to listen on", async () => {
    await createDevice({ slug: "ntp-one", ntp_port: "55123" });
    await createDevice({ slug: "plain-dyndns" });
    const res = await fetchWorker(`${HOST}/agent/config`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ports: { port: number; device: string }[] };
    expect(body.ports).toContainEqual({ port: 55123, device: "ntp-one" });
    expect(body.ports.find((p) => p.device === "plain-dyndns")).toBeUndefined();
  });

  it("updates DNS from the address seen on an NTP port", async () => {
    await createDevice({ slug: "ntp-two", ntp_port: "55124", legacy_hostname: "two.dyndns.org" });
    const res = await fetchWorker(`${HOST}/agent/report`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ reports: [{ port: 55124, ip: "203.0.113.70" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ port: 55124, result: "good" }] });
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

  it("refuses two devices on the same NTP port", async () => {
    await createDevice({ slug: "port-a", ntp_port: "55130" });
    await expect(createDevice({ slug: "port-b", ntp_port: "55130" })).rejects.toThrow(/port 55130/i);
  });
});
