// Minimal stand-in for the Cloudflare DNS records API, for local end-to-end runs.
import { createServer } from "node:http";

const records = [];
let next = 1;
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  for await (const c of req) body += c;
  const send = (result) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, result }));
  };
  if (url.pathname === "/records") return send(records);
  const m = url.pathname.match(/^\/zones\/[^/]+\/dns_records\/?([^/]*)$/);
  if (!m) return res.writeHead(404).end();
  if (req.method === "GET") return send(records.filter((r) => r.name === url.searchParams.get("name") && r.type === url.searchParams.get("type")));
  if (req.method === "POST") { const r = { ...JSON.parse(body), id: `r${next++}` }; records.push(r); return send(r); }
  const r = records.find((x) => x.id === m[1]);
  if (req.method === "PATCH") { Object.assign(r, JSON.parse(body)); return send(r); }
  if (req.method === "DELETE") { records.splice(records.indexOf(r), 1); return send({ id: m[1] }); }
}).listen(18788, "127.0.0.1", () => console.log("fake cloudflare on :18788"));
