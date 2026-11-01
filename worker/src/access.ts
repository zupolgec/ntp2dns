import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { messages, type Messages } from "./i18n";

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// The panel sits behind a Cloudflare Access application; the Worker checks the
// Access token too, so a missing Access policy never exposes it.
export const requireAccess: MiddlewareHandler<{ Bindings: Env; Variables: { user: string; t: Messages } }> = async (
  c,
  next,
) => {
  const t = messages(c.env.PANEL_LANG);
  c.set("t", t);
  const url = new URL(c.req.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";

  if (c.env.ADMIN_AUTH_DISABLED === "true" && local) {
    c.set("user", "localhost");
  } else {
    const token = c.req.header("cf-access-jwt-assertion");
    const team = c.env.ACCESS_TEAM_DOMAIN;
    if (!token || !team || !c.env.ACCESS_AUD) return c.text(t.forbidden, 403);
    let set = jwks.get(team);
    if (!set) jwks.set(team, (set = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`))));
    try {
      const { payload } = await jwtVerify(token, set, { issuer: `https://${team}`, audience: c.env.ACCESS_AUD });
      c.set("user", String(payload.email ?? payload.sub));
    } catch {
      return c.text(t.forbidden, 403);
    }
  }

  // Form posts must come from the panel itself.
  if (c.req.method !== "GET" && c.req.header("origin") !== url.origin) return c.text(t.badRequest, 403);
  await next();
};
