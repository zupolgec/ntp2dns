export type Env = {
  DB: D1Database;
  ZONE_NAME: string;
  CF_ZONE_ID: string;
  CF_API_TOKEN: string;
  AGENT_TOKEN: string;
  DYN_USERNAME?: string;
  DYN_UPDATER_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Shown in the setup help of NTP devices: public address of the NTP agent.
  NTP_HOST?: string;
  // UDP port range the panel hands out to NTP devices (default 55123-55199).
  NTP_PORT_MIN?: string;
  NTP_PORT_MAX?: string;
  // Panel language: "en" (default) or "it".
  PANEL_LANG?: string;
  // Time zone for dates in the panel (default UTC), e.g. "Europe/Rome".
  TIME_ZONE?: string;
  // Local end-to-end runs point this at a fake of the Cloudflare API.
  CF_API_BASE?: string;
  // Only honoured on localhost, for `wrangler dev` and tests.
  ADMIN_AUTH_DISABLED?: string;
};

export type Device = {
  id: number;
  slug: string;
  label: string;
  notes: string;
  password: string;
  ntp_port: number | null;
  legacy_hostname: string | null;
  legacy_http: number;
  alert_hours: number;
  enabled: number;
  ipv4: string | null;
  ipv6: string | null;
  last_seen_at: string | null;
  last_change_at: string | null;
  last_source: string | null;
  created_at: string;
};

export type Source = "dyndns" | "ntp" | "http";
