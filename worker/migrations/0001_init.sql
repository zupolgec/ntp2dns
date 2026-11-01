create table devices (
  id integer primary key,
  slug text not null unique,            -- DNS label and dyndns2 username
  label text not null,
  notes text not null default '',
  password_hash text not null,          -- sha256 hex of a random 128-bit token
  ntp_port integer unique,              -- set when the device is tracked through the NTP agent
  legacy_hostname text unique,          -- old dyndns.org name, mirrored on every change
  legacy_http integer not null default 0, -- answers the plain /?host=<legacy_hostname> link
  alert_hours integer not null default 24,
  enabled integer not null default 1,
  ipv4 text,
  ipv6 text,
  last_seen_at text,
  last_change_at text,
  last_source text,                     -- dyndns | ntp | http
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

create table ip_history (
  id integer primary key,
  device_id integer not null references devices(id) on delete cascade,
  ip text not null,
  source text not null,
  mirror_result text,
  at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

create index ip_history_device on ip_history(device_id, at desc);
