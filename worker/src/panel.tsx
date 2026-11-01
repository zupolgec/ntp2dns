import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { requireAccess } from "./access";
import { newSecret, sha256 } from "./crypto";
import { fqdn, getById, removeDevice, SLUG_RE } from "./devices";
import type { Device, Env } from "./env";
import type { Messages } from "./i18n";

type App = { Bindings: Env; Variables: { user: string; t: Messages } };
export const panel = new Hono<App>();
panel.use(requireAccess);

// Names a device cannot take, so it never shadows the panel or usual services
// when the zone is shared with them.
const RESERVED_SLUGS = new Set(["www", "ddns", "dyn", "api", "admin", "mail", "smtp", "imap", "ns1", "ns2"]);

const portRange = (env: Env) => ({
  min: Number(env.NTP_PORT_MIN ?? 55123),
  max: Number(env.NTP_PORT_MAX ?? 55199),
});

const css = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e3df;--ok:#1f7a4d;--warn:#b54708;--off:#8a8a85;--accent:#2b59c3}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--fg:#ecece8;--muted:#9a9a94;--line:#2f2f2c;--ok:#4cc38a;--warn:#f5a524;--off:#77776f;--accent:#7ea2ff}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--card)}
header a{color:inherit;text-decoration:none;font-weight:600}header small{color:var(--muted)}
main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 16px}h2{font-size:16px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
tr:last-child td{border-bottom:0}td a{color:var(--accent);text-decoration:none;font-weight:500}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.ok{background:var(--ok)}.warn{background:var(--warn)}.off{background:var(--off)}
.row{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-bottom:12px}
.btn{display:inline-block;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;padding:7px 12px;font:inherit;cursor:pointer;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.danger{color:#c4320a}
form.inline{display:inline}
label{display:block;font-weight:500;margin:12px 0 4px}label .muted{font-weight:400}
input[type=text],input[type=number],textarea{width:100%;max-width:420px;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit}
.check{display:flex;gap:8px;align-items:center;font-weight:400}
.error{border-color:#c4320a;color:#c4320a}
.secret{font-size:16px;padding:8px 10px;border:1px dashed var(--warn);border-radius:7px;display:inline-block;user-select:all}
dl{display:grid;grid-template-columns:200px 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
`;

function Layout(props: { title: string; user: string; t: Messages; children: Child }) {
  return (
    <html lang={props.t.lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>
          {props.title} · {props.t.appName}
        </title>
        <link rel="icon" href="data:," />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <header>
          <a href="/admin">{props.t.appName}</a>
          <small>{props.user}</small>
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

function ago(t: Messages, iso: string | null): string {
  if (!iso) return t.never;
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return t.justNow;
  if (min < 60) return t.minutesAgo(min);
  const h = Math.round(min / 60);
  if (h < 48) return t.hoursAgo(h);
  return t.daysAgo(Math.round(h / 24));
}

function status(t: Messages, d: Device): { cls: string; text: string } {
  if (!d.enabled) return { cls: "off", text: t.statusDisabled };
  if (!d.last_seen_at) return { cls: "off", text: t.statusNeverSeen };
  const silentH = (Date.now() - Date.parse(d.last_seen_at)) / 3600000;
  return silentH > d.alert_hours ? { cls: "warn", text: t.statusSilent } : { cls: "ok", text: t.statusOk };
}

function when(env: Env, t: Messages, iso: string) {
  return new Intl.DateTimeFormat(t.locale, {
    timeZone: env.TIME_ZONE ?? "UTC",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

// Answer of members.dyndns.org for the old name, as stored in the history.
function mirrorLabel(t: Messages, raw: string | null): string {
  if (!raw) return "-";
  if (raw === "skipped") return t.mirrorSkipped;
  if (raw.startsWith("good") || raw.startsWith("nochg")) return t.mirrorOk;
  return t.mirrorError(raw);
}

function sourceLabel(t: Messages, source: string) {
  return source === "ntp" ? t.sourceNtp : source === "http" ? t.sourceHttp : t.sourceDyndns;
}

panel.get("/", async (c) => {
  const t = c.get("t");
  const { results } = await c.env.DB.prepare("select * from devices order by label collate nocase").all<Device>();
  const silent = results.filter((d) => status(t, d).cls === "warn").length;
  return c.html(
    <Layout title={t.devices} user={c.get("user")} t={t}>
      <div class="row">
        <h1>
          {t.devices}{" "}
          <span class="muted">
            ({results.length}
            {silent ? `, ${t.notResponding(silent)}` : ""})
          </span>
        </h1>
        <a class="btn primary" href="/admin/devices/new">
          {t.newDevice}
        </a>
      </div>
      {results.length === 0 ? (
        <div class="card muted">{t.emptyList}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t.colDevice}</th>
              <th>{t.colHostname}</th>
              <th>{t.colIp}</th>
              <th>{t.colLastSeen}</th>
              <th>{t.colStatus}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((d) => {
              const s = status(t, d);
              return (
                <tr>
                  <td>
                    <a href={`/admin/devices/${d.id}`}>{d.label}</a>
                    {d.legacy_hostname && <div class="muted mono">{d.legacy_hostname}</div>}
                  </td>
                  <td class="mono">{fqdn(c.env, d)}</td>
                  <td class="mono">
                    {d.ipv4 ?? "-"}
                    {d.ipv6 && <div class="muted">{d.ipv6}</div>}
                  </td>
                  <td>
                    {ago(t, d.last_seen_at)}
                    {d.last_source && <div class="muted">{sourceLabel(t, d.last_source)}</div>}
                  </td>
                  <td>
                    <span class={`dot ${s.cls}`} />
                    {s.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Layout>,
  );
});

type FormValues = {
  slug: string;
  label: string;
  notes: string;
  ntp_port: string;
  legacy_hostname: string;
  legacy_http: boolean;
  alert_hours: string;
};

async function nextFreePort(env: Env): Promise<number | null> {
  const { results } = await env.DB.prepare("select ntp_port from devices where ntp_port is not null").all<{
    ntp_port: number;
  }>();
  const used = new Set(results.map((r) => r.ntp_port));
  const { min, max } = portRange(env);
  for (let p = min; p <= max; p++) if (!used.has(p)) return p;
  return null;
}

function DeviceForm(props: {
  t: Messages;
  env: Env;
  host: string;
  action: string;
  values: FormValues;
  error?: string;
  isNew: boolean;
  freePort: number | null;
}) {
  const { t, values: v } = props;
  const { min, max } = portRange(props.env);
  return (
    <form method="post" action={props.action} class="card">
      {props.error && <p class="error">{props.error}</p>}
      {props.isNew && (
        <>
          <label for="slug">
            {t.fieldSlug} <span class="muted">{t.fieldSlugHint}</span>
          </label>
          <input type="text" id="slug" name="slug" value={v.slug} required pattern="[a-z0-9-]+" placeholder="front-gate-nvr" />
        </>
      )}
      <label for="label">{t.fieldLabel}</label>
      <input type="text" id="label" name="label" value={v.label} required />
      <label for="notes">{t.fieldNotes}</label>
      <textarea id="notes" name="notes" rows={3}>
        {v.notes}
      </textarea>
      <label for="ntp_port">
        {t.fieldNtpPort} <span class="muted">{t.fieldNtpPortHint(props.freePort)}</span>
      </label>
      <input type="number" id="ntp_port" name="ntp_port" value={v.ntp_port} min={min} max={max} />
      <label for="legacy_hostname">
        {t.fieldLegacyHostname} <span class="muted">{t.fieldLegacyHostnameHint}</span>
      </label>
      <input type="text" id="legacy_hostname" name="legacy_hostname" value={v.legacy_hostname} placeholder="example.dyndns.org" />
      <label class="check">
        <input type="checkbox" name="legacy_http" checked={v.legacy_http} /> {t.fieldLegacyHttp(props.host)}
      </label>
      <label for="alert_hours">{t.fieldAlertHours}</label>
      <input type="number" id="alert_hours" name="alert_hours" value={v.alert_hours} min={1} required />
      <p>
        <button class="btn primary" type="submit">
          {t.save}
        </button>
      </p>
    </form>
  );
}

async function readForm(c: { req: { formData(): Promise<FormData> } }): Promise<FormValues> {
  const f = await c.req.formData();
  const s = (k: string) => String(f.get(k) ?? "").trim();
  return {
    slug: s("slug").toLowerCase(),
    label: s("label"),
    notes: s("notes"),
    ntp_port: s("ntp_port"),
    legacy_hostname: s("legacy_hostname").toLowerCase(),
    legacy_http: f.get("legacy_http") === "on",
    alert_hours: s("alert_hours") || "24",
  };
}

async function validate(env: Env, t: Messages, host: string, v: FormValues, selfId: number | null): Promise<string | null> {
  if (selfId === null) {
    if (!SLUG_RE.test(v.slug)) return t.errSlug;
    if (RESERVED_SLUGS.has(v.slug) || fqdn(env, v) === host) return t.errSlugReserved;
    if (await env.DB.prepare("select 1 from devices where slug = ?").bind(v.slug).first()) return t.errSlugTaken;
  }
  if (!v.label) return t.errLabel;
  if (v.ntp_port) {
    const p = Number(v.ntp_port);
    const { min, max } = portRange(env);
    if (!Number.isInteger(p) || p < min || p > max) return t.errPortRange(min, max);
    const taken = await env.DB.prepare("select label from devices where ntp_port = ? and id is not ?")
      .bind(p, selfId)
      .first<{ label: string }>();
    if (taken) return t.errPortTaken(p, taken.label);
  }
  if (v.legacy_hostname) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v.legacy_hostname)) return t.errLegacyInvalid;
    const taken = await env.DB.prepare("select label from devices where legacy_hostname = ? and id is not ?")
      .bind(v.legacy_hostname, selfId)
      .first<{ label: string }>();
    if (taken) return t.errLegacyTaken(taken.label);
  }
  if (v.legacy_http && !v.legacy_hostname) return t.errLegacyHttpNeedsHostname;
  const h = Number(v.alert_hours);
  if (!Number.isInteger(h) || h < 1) return t.errAlertHours;
  return null;
}

const empty: FormValues = {
  slug: "",
  label: "",
  notes: "",
  ntp_port: "",
  legacy_hostname: "",
  legacy_http: false,
  alert_hours: "24",
};

const hostOf = (url: string) => new URL(url).host;

panel.get("/devices/new", async (c) => {
  const t = c.get("t");
  return c.html(
    <Layout title={t.newDevice} user={c.get("user")} t={t}>
      <h1>{t.newDevice}</h1>
      <DeviceForm
        t={t}
        env={c.env}
        host={hostOf(c.req.url)}
        action="/admin/devices"
        values={empty}
        isNew
        freePort={await nextFreePort(c.env)}
      />
    </Layout>,
  );
});

function SetupHelp(props: { t: Messages; env: Env; d: Device; host: string; secret?: string }) {
  const { t, d } = props;
  const pass = props.secret ?? t.passwordPlaceholder;
  return (
    <div class="card">
      <h2 style="margin-top:0">{t.setupTitle}</h2>
      {props.secret && (
        <p>
          {t.password}:{" "}
          <span class="secret mono" data-secret={props.secret}>
            {props.secret}
          </span>
          <br />
          <span class="muted">{t.passwordOnce}</span>
        </p>
      )}
      {d.ntp_port ? (
        <dl>
          <dt>{t.setupNtpServer}</dt>
          <dd class="mono">{props.env.NTP_HOST ?? "-"}</dd>
          <dt>{t.setupNtpPort}</dt>
          <dd class="mono">{d.ntp_port}</dd>
          <dt>{t.setupHostname}</dt>
          <dd class="mono">{fqdn(props.env, d)}</dd>
        </dl>
      ) : (
        <dl>
          <dt>{t.setupService}</dt>
          <dd>{t.setupServiceValue}</dd>
          <dt>{t.setupServer}</dt>
          <dd class="mono">{props.host}</dd>
          <dt>{t.setupHostname}</dt>
          <dd class="mono">{fqdn(props.env, d)}</dd>
          <dt>{t.setupUser}</dt>
          <dd class="mono">{d.slug}</dd>
          <dt>{t.setupFullUrl}</dt>
          <dd class="mono" style="word-break:break-all">
            https://{d.slug}:{pass}@{props.host}/nic/update?hostname={fqdn(props.env, d)}&amp;myip=&lt;ip&gt;
          </dd>
        </dl>
      )}
    </div>
  );
}

panel.post("/devices", async (c) => {
  const t = c.get("t");
  const host = hostOf(c.req.url);
  const v = await readForm(c);
  const error = await validate(c.env, t, host, v, null);
  if (error)
    return c.html(
      <Layout title={t.newDevice} user={c.get("user")} t={t}>
        <h1>{t.newDevice}</h1>
        <DeviceForm
          t={t}
          env={c.env}
          host={host}
          action="/admin/devices"
          values={v}
          error={error}
          isNew
          freePort={await nextFreePort(c.env)}
        />
      </Layout>,
      422,
    );

  const secret = newSecret();
  const d = (await c.env.DB.prepare(
    `insert into devices (slug, label, notes, password_hash, ntp_port, legacy_hostname, legacy_http, alert_hours)
     values (?, ?, ?, ?, ?, ?, ?, ?) returning *`,
  )
    .bind(
      v.slug,
      v.label,
      v.notes,
      await sha256(secret),
      v.ntp_port ? Number(v.ntp_port) : null,
      v.legacy_hostname || null,
      v.legacy_http ? 1 : 0,
      Number(v.alert_hours),
    )
    .first<Device>())!;

  return c.html(
    <Layout title={d.label} user={c.get("user")} t={t}>
      <h1>{t.created(d.label)}</h1>
      <SetupHelp t={t} env={c.env} d={d} host={host} secret={secret} />
      <a class="btn" href={`/admin/devices/${d.id}`}>
        {t.goToDevice}
      </a>
    </Layout>,
  );
});

panel.get("/devices/:id{[0-9]+}", async (c) => {
  const t = c.get("t");
  const host = hostOf(c.req.url);
  const d = await getById(c.env, Number(c.req.param("id")));
  if (!d) return c.notFound();
  const { results: history } = await c.env.DB.prepare(
    "select * from ip_history where device_id = ? order by at desc limit 50",
  )
    .bind(d.id)
    .all<{ ip: string; source: string; mirror_result: string | null; at: string }>();
  const s = status(t, d);
  return c.html(
    <Layout title={d.label} user={c.get("user")} t={t}>
      <div class="row">
        <h1>
          {d.label} <span class="muted mono">{fqdn(c.env, d)}</span>
        </h1>
        <span>
          <span class={`dot ${s.cls}`} />
          {d.last_seen_at ? t.lastContact(s.text, ago(t, d.last_seen_at)) : s.text}
        </span>
      </div>
      <SetupHelp t={t} env={c.env} d={d} host={host} />
      <h2>{t.ipChanges}</h2>
      {history.length === 0 ? (
        <div class="card muted">{t.noChanges}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t.colWhen}</th>
              <th>{t.colIpShort}</th>
              <th>{t.colFrom}</th>
              <th>{t.colLegacy}</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr>
                <td class="mono">{when(c.env, t, h.at)}</td>
                <td class="mono">{h.ip}</td>
                <td>{sourceLabel(t, h.source)}</td>
                <td class="muted">{mirrorLabel(t, h.mirror_result)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>{t.edit}</h2>
      <DeviceForm
        t={t}
        env={c.env}
        host={host}
        action={`/admin/devices/${d.id}`}
        isNew={false}
        freePort={await nextFreePort(c.env)}
        values={{
          slug: d.slug,
          label: d.label,
          notes: d.notes,
          ntp_port: d.ntp_port ? String(d.ntp_port) : "",
          legacy_hostname: d.legacy_hostname ?? "",
          legacy_http: d.legacy_http === 1,
          alert_hours: String(d.alert_hours),
        }}
      />
      <div class="card">
        <form class="inline" method="post" action={`/admin/devices/${d.id}/rotate`}>
          <button class="btn" type="submit">
            {t.rotatePassword}
          </button>
        </form>{" "}
        <form class="inline" method="post" action={`/admin/devices/${d.id}/toggle`}>
          <button class="btn" type="submit">
            {d.enabled ? t.disable : t.enable}
          </button>
        </form>{" "}
        <form
          class="inline"
          method="post"
          action={`/admin/devices/${d.id}/delete`}
          onsubmit={`return confirm(${JSON.stringify(t.deleteConfirm)})`}
        >
          <button class="btn danger" type="submit">
            {t.delete}
          </button>
        </form>
      </div>
    </Layout>,
  );
});

panel.post("/devices/:id{[0-9]+}", async (c) => {
  const t = c.get("t");
  const host = hostOf(c.req.url);
  const d = await getById(c.env, Number(c.req.param("id")));
  if (!d) return c.notFound();
  const v = { ...(await readForm(c)), slug: d.slug };
  const error = await validate(c.env, t, host, v, d.id);
  if (error)
    return c.html(
      <Layout title={d.label} user={c.get("user")} t={t}>
        <h1>{d.label}</h1>
        <DeviceForm
          t={t}
          env={c.env}
          host={host}
          action={`/admin/devices/${d.id}`}
          values={v}
          error={error}
          isNew={false}
          freePort={null}
        />
      </Layout>,
      422,
    );
  await c.env.DB.prepare(
    "update devices set label = ?, notes = ?, ntp_port = ?, legacy_hostname = ?, legacy_http = ?, alert_hours = ? where id = ?",
  )
    .bind(
      v.label,
      v.notes,
      v.ntp_port ? Number(v.ntp_port) : null,
      v.legacy_hostname || null,
      v.legacy_http ? 1 : 0,
      Number(v.alert_hours),
      d.id,
    )
    .run();
  return c.redirect(`/admin/devices/${d.id}`, 303);
});

panel.post("/devices/:id{[0-9]+}/rotate", async (c) => {
  const t = c.get("t");
  const d = await getById(c.env, Number(c.req.param("id")));
  if (!d) return c.notFound();
  const secret = newSecret();
  await c.env.DB.prepare("update devices set password_hash = ? where id = ?").bind(await sha256(secret), d.id).run();
  return c.html(
    <Layout title={d.label} user={c.get("user")} t={t}>
      <h1>{t.newPasswordFor(d.label)}</h1>
      <p>{t.oldPasswordGone}</p>
      <SetupHelp t={t} env={c.env} d={d} host={hostOf(c.req.url)} secret={secret} />
      <a class="btn" href={`/admin/devices/${d.id}`}>
        {t.backToDevice}
      </a>
    </Layout>,
  );
});

panel.post("/devices/:id{[0-9]+}/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("update devices set enabled = 1 - enabled where id = ?").bind(id).run();
  return c.redirect(`/admin/devices/${id}`, 303);
});

panel.post("/devices/:id{[0-9]+}/delete", async (c) => {
  const d = await getById(c.env, Number(c.req.param("id")));
  if (!d) return c.notFound();
  await removeDevice(c.env, d);
  return c.redirect("/admin", 303);
});

