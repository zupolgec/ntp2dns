import { Hono } from "hono";
import { agent } from "./agent";
import { legacyHttp, nicUpdate } from "./dyndns";
import type { Env } from "./env";
import { messages } from "./i18n";
import { panel } from "./panel";

const app = new Hono<{ Bindings: Env }>();

app.get("/nic/update", nicUpdate);
app.get("/v3/update", nicUpdate);
app.route("/agent", agent);
app.route("/admin", panel);
app.get("/", async (c) => (c.req.query("host") ? legacyHttp(c) : c.redirect("/admin")));

app.onError((err, c) => {
  console.error(err);
  // dyndns2 clients understand "911" as "server problem, retry later".
  if (c.req.path.endsWith("/update") || c.req.query("host")) return c.text("911", 500);
  return c.text(messages(c.env.PANEL_LANG).internalError, 500);
});

export default app;
