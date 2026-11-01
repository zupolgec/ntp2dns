import { Hono } from "hono";
import { safeEqual } from "./crypto";
import { getByPort, parseIp, report } from "./devices";
import type { Env } from "./env";

// API for the NTP agent running on the server with the fixed IP.
export const agent = new Hono<{ Bindings: Env }>();

agent.use(async (c, next) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
  if (!c.env.AGENT_TOKEN || !safeEqual(token, c.env.AGENT_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

agent.get("/config", async (c) => {
  const { results } = await c.env.DB.prepare(
    "select ntp_port as port, slug as device from devices where ntp_port is not null and enabled = 1 order by ntp_port",
  ).all<{ port: number; device: string }>();
  return c.json({ ports: results });
});

type Report = { port: number; ip: string };

agent.post("/report", async (c) => {
  const body = await c.req.json<{ reports?: Report[] }>().catch(() => ({ reports: undefined }));
  if (!Array.isArray(body.reports) || body.reports.length > 100) return c.json({ error: "bad request" }, 400);

  const results = [];
  for (const r of body.reports) {
    const ip = typeof r.ip === "string" ? parseIp(r.ip) : null;
    const device = Number.isInteger(r.port) ? await getByPort(c.env, r.port) : null;
    if (!ip) results.push({ port: r.port, result: "badip" });
    else if (!device) results.push({ port: r.port, result: "nohost" });
    else results.push({ port: r.port, result: await report(c.env, device, ip, "ntp") });
  }
  return c.json({ results });
});
